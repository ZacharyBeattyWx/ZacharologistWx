import asyncio
import os
import sys
import time

import slixmpp


class NwwsSmokeTest(slixmpp.ClientXMPP):
    def __init__(self, jid, password, room, nick, room_password, timeout_seconds):
        super().__init__(jid, password)

        self.room = room
        self.nick = nick
        self.room_password = room_password
        self.timeout_seconds = timeout_seconds
        self.joined = False
        self.received_product = False

        self.add_event_handler("session_start", self.session_start)
        self.add_event_handler("failed_auth", self.failed_auth)
        self.add_event_handler("connection_failed", self.connection_failed)
        self.add_event_handler("disconnected", self.disconnected)
        self.add_event_handler(f"muc::{self.room}::got_online", self.muc_online)
        self.add_event_handler("groupchat_message", self.groupchat_message)

        self.register_plugin("xep_0030")
        self.register_plugin("xep_0045")
        self.register_plugin("xep_0199")

    async def session_start(self, _event):
        print("NWWS smoke: connected and authenticated.")
        print(f"NWWS smoke: joining {self.room} as {self.nick}")

        self.plugin["xep_0045"].join_muc(
            self.room,
            self.nick,
            password=self.room_password,
            maxhistory="0"
        )

        asyncio.create_task(self.timeout_watch())

    async def timeout_watch(self):
        await asyncio.sleep(self.timeout_seconds)

        if self.received_product:
            return

        if self.joined:
            print("NWWS smoke: joined successfully but no product arrived before timeout.")
            self.disconnect()
            return

        print("NWWS smoke: timed out before confirmed room join.")
        self.disconnect()
        sys.exit(2)

    def failed_auth(self, _event):
        print("NWWS smoke: authentication failed.")
        self.disconnect()
        sys.exit(3)

    def connection_failed(self, event):
        print(f"NWWS smoke: connection failed: {event}")
        self.disconnect()
        sys.exit(4)

    def disconnected(self, _event):
        print("NWWS smoke: disconnected.")

    def muc_online(self, presence):
        if presence["muc"]["nick"] == self.nick and not self.joined:
            self.joined = True
            print("NWWS smoke: joined room and waiting for product traffic.")

    def groupchat_message(self, msg):
        sender = str(msg["mucnick"] or "")
        if sender == self.nick:
            return

        body = str(msg["body"] or "").strip()
        subject = str(msg["subject"] or "").strip()

        if not body and not subject:
            return

        self.received_product = True

        preview_lines = (subject + "\n" + body).splitlines()
        preview = " | ".join(
            line.strip()
            for line in preview_lines
            if line.strip()
        )[:900]

        print("NWWS smoke: received product.")
        print(f"NWWS smoke: from={sender}")
        print(f"NWWS smoke: preview={preview}")

        self.disconnect()
        sys.exit(0)


def required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"Missing required environment variable: {name}")
        sys.exit(1)
    return value


def main():
    username = required_env("NWWS_USERNAME")
    password = required_env("NWWS_PASSWORD")
    domain = os.environ.get("NWWS_DOMAIN", "nwws-oi.weather.gov").strip()
    resource = os.environ.get("NWWS_RESOURCE", "nwws").strip()
    port = int(os.environ.get("NWWS_PORT", "5222"))

    bare_user = username.split("@", 1)[0].strip()
    jid = f"{bare_user}@{domain}/{resource}"

    room = "NWWS@conference.nwws-oi.weather.gov"
    nick = f"zacharologistwx-smoke-{int(time.time())}"

    print(f"NWWS smoke: attempting login as [user]@{domain}/{resource}")

    xmpp = NwwsSmokeTest(
        jid=jid,
        password=password,
        room=room,
        nick=nick,
        room_password=password,
        timeout_seconds=180
    )

    # Match NWWS/Pidgin behavior: connect on 5222, then upgrade with STARTTLS.
    xmpp.enable_direct_tls = False
    xmpp.enable_starttls = True
    xmpp.enable_plaintext = False

    xmpp.connect(domain, port)
    xmpp.loop.run_until_complete(xmpp.disconnected)


if __name__ == "__main__":
    main()