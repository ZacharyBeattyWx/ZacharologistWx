#!/usr/bin/env python3
"""Production radar publisher wrapper.

MRMS remains the primary/required publisher. The experimental NEXRAD N0B
archive is published independently afterward. A NEXRAD/Unidata failure is
reported in the Lambda result and logs but does not roll back or fail an
otherwise-successful MRMS publication.
"""

from __future__ import annotations

import traceback

from handler_v2 import lambda_handler as publish_mrms
from nexrad_publisher import publish_nexrad_n0b


def lambda_handler(event, context):
    event = event or {}
    result = publish_mrms(event, context)

    try:
        nexrad_result = publish_nexrad_n0b(event)
    except Exception as exc:  # Keep the working MRMS pipeline isolated.
        print("NEXRAD N0B publisher failed; MRMS publication remains valid")
        traceback.print_exc()
        nexrad_result = {
            "status": "error",
            "error": str(exc),
        }

    if isinstance(result, dict):
        result = dict(result)
        result["nexrad"] = nexrad_result
        return result

    return {
        "mrms": result,
        "nexrad": nexrad_result,
    }
