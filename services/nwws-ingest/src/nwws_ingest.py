import json
import logging
import os
import re
import signal
import sys
import time
import requests
from datetime import datetime, timezone

import boto3
import slixmpp


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("nwws-ingest")
logging.getLogger("slixmpp").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)


VTEC_RE = re.compile(
    r"/O\."
    r"(?P<action>[A-Z]{3})\."
    r"(?P<office>[A-Z0-9]{4})\."
    r"(?P<phenom>[A-Z]{2})\."
    r"(?P<sig>[A-Z])\."
    r"(?P<etn>\d{4})\."
    r"(?P<begin>\d{6}T\d{4}Z)-"
    r"(?P<end>\d{6}T\d{4}Z)"
    r"/"
)

EVENT_NAMES = {
    ("TO", "W"): "Tornado Warning",
    ("SV", "W"): "Severe Thunderstorm Warning",
    ("FF", "W"): "Flash Flood Warning",
    ("MA", "W"): "Special Marine Warning",
    ("SQ", "W"): "Snow Squall Warning",
    ("DS", "W"): "Dust Storm Warning",
    ("EW", "W"): "Extreme Wind Warning",
    ("HU", "W"): "Hurricane Warning",
    ("TR", "W"): "Tropical Storm Warning",
    ("TY", "W"): "Typhoon Warning",
    ("SS", "W"): "Storm Surge Warning",
    ("FA", "W"): "Areal Flood Warning",
    ("FL", "W"): "Flood Warning",
    ("FW", "W"): "Red Flag Warning",
    ("BZ", "W"): "Blizzard Warning",
    ("WS", "W"): "Winter Storm Warning",
    ("IS", "W"): "Ice Storm Warning",
    ("LE", "W"): "Lake Effect Snow Warning",
    ("WW", "Y"): "Winter Weather Advisory",
    ("TO", "A"): "Tornado Watch",
    ("SV", "A"): "Severe Thunderstorm Watch",
    ("FF", "A"): "Flash Flood Watch",
    ("FA", "A"): "Flood Watch",
    ("HU", "A"): "Hurricane Watch",
    ("TR", "A"): "Tropical Storm Watch",
    ("SS", "A"): "Storm Surge Watch",
    ("FW", "A"): "Fire Weather Watch",
}

DELETE_ACTIONS = {"CAN", "EXP"}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_vtec_time(value):
    value = str(value or "").strip().upper()

    if not value or value == "000000T0000Z":
        return ""

    try:
        year = int(value[0:2])
        year += 2000 if year < 70 else 1900
        month = int(value[2:4])
        day = int(value[4:6])
        hour = int(value[7:9])
        minute = int(value[9:11])
        return datetime(year, month, day, hour, minute, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return ""


def compact_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_secret(secret_id):
    client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    response = client.get_secret_value(SecretId=secret_id)
    return json.loads(response["SecretString"])


def product_id_from_attrs(attrs, text):
    for key in ("id", "awipsid", "ttaaii"):
        value = str(attrs.get(key, "")).strip()
        if value:
            return value

    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return first_line[:80] or f"nwws-product-{int(time.time())}"


def iter_nwws_elements(stanza_xml):
    try:
        for element in stanza_xml.iter():
            tag = str(element.tag)
            if tag == "{nwws-oi}x" or tag.endswith("}x"):
                if tag.startswith("{nwws-oi}") or element.attrib.get("xmlns") == "nwws-oi":
                    yield element
    except Exception:
        return


def extract_products_from_message(msg):
    products = []

    for element in iter_nwws_elements(msg.xml):
        text = "".join(element.itertext()).strip()
        attrs = dict(element.attrib or {})
        if text:
            products.append({"attrs": attrs, "text": text})

    if products:
        return products

    subject = str(msg["subject"] or "").strip()
    body = str(msg["body"] or "").strip()
    text = "\n".join(part for part in (subject, body) if part).strip()

    if text:
        return [{"attrs": {}, "text": text}]

    return []


def collect_latlon_tokens(text):
    lines = text.splitlines()
    tokens = []
    collecting = False

    for line in lines:
        clean = line.strip()

        if "LAT...LON" in clean:
            collecting = True
            clean = clean.split("LAT...LON", 1)[1].strip()

        if not collecting:
            continue

        line_tokens = re.findall(r"\b\d{4,5}\b", clean)

        if line_tokens:
            tokens.extend(line_tokens)
            continue

        if tokens:
            break

    return tokens


def parse_latlon_polygon(text):
    tokens = collect_latlon_tokens(text)

    if len(tokens) < 6 or len(tokens) % 2 != 0:
        return None

    coordinates = []

    for lat_token, lon_token in zip(tokens[0::2], tokens[1::2]):
        try:
            lat = int(lat_token[:2]) + (int(lat_token[2:]) / 100.0)
            lon = int(lon_token[:-2]) + (int(lon_token[-2:]) / 100.0)
            coordinates.append([-lon, lat])
        except Exception:
            return None

    if len(coordinates) < 3:
        return None

    if coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])

    return {
        "type": "Polygon",
        "coordinates": [coordinates],
    }


def event_name(phenom, sig):
    return EVENT_NAMES.get((phenom, sig)) or f"NWS {phenom}.{sig}"


def canonical_alert_id(entry):
    return f"nwws:{entry['office']}:{entry['phenom']}.{entry['sig']}:{entry['etn']}"


def headline_for_product(text, event):
    for line in text.splitlines():
        clean = compact_text(line)
        if not clean:
            continue

        if event.lower() in clean.lower():
            return clean

    for line in text.splitlines():
        clean = compact_text(line)
        if clean and not clean.startswith("/") and len(clean) > 8:
            return clean[:180]

    return event


def parse_alert_payload(product):
    attrs = product.get("attrs") or {}
    text = product.get("text") or ""
    product_id = product_id_from_attrs(attrs, text)
    entries = [match.groupdict() for match in VTEC_RE.finditer(text)]

    if not entries:
        return None

    geometry = parse_latlon_polygon(text)
    features = []
    delete_ids = []

    for entry in entries:
        alert_id = canonical_alert_id(entry)
        action = entry["action"]
        event = event_name(entry["phenom"], entry["sig"])
        effective = parse_vtec_time(entry["begin"])
        expires = parse_vtec_time(entry["end"])

        if action in DELETE_ACTIONS:
            delete_ids.append(alert_id)
            continue

        features.append({
            "type": "Feature",
            "id": alert_id,
            "geometry": geometry,
            "properties": {
                "id": alert_id,
                "identifier": alert_id,
                "event": event,
                "headline": headline_for_product(text, event),
                "description": text,
                "sent": attrs.get("issue") or effective or utc_now_iso(),
                "effective": effective,
                "expires": expires,
                "ends": expires,
                "status": "Actual",
                "messageType": action,
                "source": "NWWS-OI",
                "senderName": entry["office"],
                "office": entry["office"],
                "phenomenon": entry["phenom"],
                "significance": entry["sig"],
                "eventTrackingNumber": entry["etn"],
                "vtecAction": action,
                "nwwsProductId": product_id,
                "_alertId": alert_id,
                "_liveAlert": True,
                "_liveSource": "nwws-oi",
                "_liveUpdatedAt": utc_now_iso(),
            },
        })

    return {
        "source": "nwws-oi",
        "features": features,
        "deleteIds": delete_ids,
        "product": {
            "id": product_id,
            "attrs": attrs,
            "hasGeometry": geometry is not None,
            "vtecCount": len(entries),
        },
    }


class CloudflarePoster:
    def __init__(self, ingest_url, token, dry_run=False, timeout=10):
        self.ingest_url = ingest_url
        self.token = token
        self.dry_run = dry_run
        self.timeout = timeout

    def post(self, payload):
        feature_count = len(payload.get("features") or [])
        delete_count = len(payload.get("deleteIds") or [])

        if feature_count == 0 and delete_count == 0:
            return

        if self.dry_run:
            logger.info(
                "DRY RUN would post to Cloudflare: features=%s deleteIds=%s product=%s",
                feature_count,
                delete_count,
                payload.get("product", {}).get("id", ""),
            )
            return

        try:
            response = requests.post(
                self.ingest_url,
                json=payload,
                timeout=self.timeout,
                headers={
                    "authorization": f"Bearer {self.token}",
                    "user-agent": "ZacharologistWx-NWWS-Ingest/1.0",
                    "accept": "application/json",
                },
            )

            if not response.ok:
                logger.error(
                    "Cloudflare ingest HTTP %s: %s",
                    response.status_code,
                    response.text[:500],
                )
                response.raise_for_status()

            logger.info("Cloudflare ingest accepted: %s", response.text[:500])
        except Exception:
            logger.exception("Cloudflare ingest failed")
            raise

class NwwsIngestClient(slixmpp.ClientXMPP):
    def __init__(self, jid, password, room, nick, room_password, poster, max_products=0):
        super().__init__(jid, password)

        self.room = room
        self.nick = nick
        self.room_password = room_password
        self.poster = poster
        self.max_products = max_products
        self.product_count = 0
        self.joined = False
        self.stop_requested = False

        self.register_plugin("xep_0030")
        self.register_plugin("xep_0045")
        self.register_plugin("xep_0199")

        self.add_event_handler("session_start", self.on_session_start)
        self.add_event_handler("failed_auth", self.on_failed_auth)
        self.add_event_handler("connection_failed", self.on_connection_failed)
        self.add_event_handler("disconnected", self.on_disconnected)
        self.add_event_handler(f"muc::{self.room}::got_online", self.on_muc_online)
        self.add_event_handler("groupchat_message", self.on_groupchat_message)

    async def on_session_start(self, _event):
        logger.info("NWWS authenticated")
        logger.info("Joining room %s as %s", self.room, self.nick)

        self.plugin["xep_0045"].join_muc(
            self.room,
            self.nick,
            password=self.room_password,
            maxhistory="0",
        )

    def on_failed_auth(self, _event):
        logger.error("NWWS authentication failed")
        self.disconnect()

    def on_connection_failed(self, event):
        logger.error("NWWS connection failed: %s", event)
        self.disconnect()

    def on_disconnected(self, _event):
        logger.warning("NWWS disconnected")

    def on_muc_online(self, presence):
        if presence["muc"]["nick"] == self.nick and not self.joined:
            self.joined = True
            logger.info("Joined NWWS room")

    def on_groupchat_message(self, msg):
        if self.stop_requested:
            return

        sender = str(msg["mucnick"] or "")

        if sender == self.nick:
            return

        for product in extract_products_from_message(msg):
            self.product_count += 1
            payload = parse_alert_payload(product)

            if not payload:
                preview = compact_text(product.get("text", ""))[:180]
                logger.info("Ignored non-alert NWWS product from=%s preview=%s", sender, preview)
            else:
                product_id = payload.get("product", {}).get("id", "")
                logger.info(
                    "Parsed alert product id=%s features=%s deleteIds=%s geometry=%s",
                    product_id,
                    len(payload.get("features") or []),
                    len(payload.get("deleteIds") or []),
                    payload.get("product", {}).get("hasGeometry"),
                )
                self.poster.post(payload)

            if self.max_products and self.product_count >= self.max_products:
                self.stop_requested = True
                logger.info("Reached NWWS_MAX_PRODUCTS=%s; disconnecting", self.max_products)
                self.disconnect()
                return


def build_client(nwws_secret, cf_secret, dry_run=False, max_products=0):
    username = str(nwws_secret["username"]).split("@", 1)[0].strip()
    password = str(nwws_secret["password"])
    domain = str(nwws_secret.get("domain") or "nwws-oi.weather.gov").strip()
    resource = str(nwws_secret.get("resource") or "nwws").strip()
    port = int(nwws_secret.get("port") or 5222)

    jid = f"{username}@{domain}/{resource}"
    room = "NWWS@conference.nwws-oi.weather.gov"
    nick = f"zacharologistwx-ingest-{int(time.time())}"

    poster = CloudflarePoster(
        ingest_url=cf_secret["ingestUrl"],
        token=cf_secret["token"],
        dry_run=dry_run,
    )

    client = NwwsIngestClient(
        jid=jid,
        password=password,
        room=room,
        nick=nick,
        room_password=password,
        poster=poster,
        max_products=max_products,
    )

    client.enable_direct_tls = False
    client.enable_starttls = True
    client.enable_plaintext = False

    return client, domain, port


def main():
    nwws_secret_id = os.environ.get("NWWS_SECRET_ID", "zacharologistwx/nwws-oi")
    cf_secret_id = os.environ.get("CLOUDFLARE_SECRET_ID", "zacharologistwx/cloudflare-live-alerts")
    dry_run = os.environ.get("NWWS_DRY_RUN", "").lower() in {"1", "true", "yes"}
    max_products = int(os.environ.get("NWWS_MAX_PRODUCTS", "0") or 0)
    reconnect_seconds = int(os.environ.get("NWWS_RECONNECT_SECONDS", "10") or 10)

    shutdown = {"stop": False}

    def handle_shutdown(_signum, _frame):
        shutdown["stop"] = True
        logger.warning("Shutdown requested")

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    logger.info("Loading secrets from AWS Secrets Manager")
    nwws_secret = load_secret(nwws_secret_id)
    cf_secret = load_secret(cf_secret_id)

    while not shutdown["stop"]:
        client, domain, port = build_client(
            nwws_secret=nwws_secret,
            cf_secret=cf_secret,
            dry_run=dry_run,
            max_products=max_products,
        )

        logger.info(
            "Connecting to NWWS as [user]@%s/%s dry_run=%s",
            domain,
            nwws_secret.get("resource", "nwws"),
            dry_run,
        )

        try:
            client.connect(domain, port)
            client.loop.run_until_complete(client.disconnected)
        except KeyboardInterrupt:
            shutdown["stop"] = True
        except Exception:
            logger.exception("NWWS client crashed")

        if max_products:
            break

        if not shutdown["stop"]:
            logger.warning("Reconnecting in %s seconds", reconnect_seconds)
            time.sleep(reconnect_seconds)

    logger.info("NWWS ingest stopped")


if __name__ == "__main__":
    main()