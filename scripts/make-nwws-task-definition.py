import copy
import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: make-nwws-task-definition.py "
            "<source.json> <output.json> <container-name> <image-uri>"
        )

    source_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    container_name = sys.argv[3]
    new_image = sys.argv[4]

    document = json.loads(source_path.read_text(encoding="utf-8"))
    task = document["taskDefinition"]
    tags = document.get("tags") or []

    allowed_fields = [
        "family",
        "taskRoleArn",
        "executionRoleArn",
        "networkMode",
        "containerDefinitions",
        "volumes",
        "placementConstraints",
        "requiresCompatibilities",
        "cpu",
        "memory",
        "pidMode",
        "ipcMode",
        "proxyConfiguration",
        "inferenceAccelerators",
        "ephemeralStorage",
        "runtimePlatform",
        "enableFaultInjection",
    ]

    request = {
        key: copy.deepcopy(task[key])
        for key in allowed_fields
        if key in task and task[key] is not None
    }

    if tags:
        request["tags"] = copy.deepcopy(tags)

    array_fields = [
        "containerDefinitions",
        "volumes",
        "placementConstraints",
        "requiresCompatibilities",
    ]

    for field in array_fields:
        value = request.get(field, [])

        if not isinstance(value, list):
            raise TypeError(
                f"{field} must be a JSON array, "
                f"found {type(value).__name__}"
            )

    matches = [
        container
        for container in request["containerDefinitions"]
        if container.get("name") == container_name
    ]

    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one container named {container_name!r}, "
            f"found {len(matches)}"
        )

    old_image = matches[0].get("image")
    matches[0]["image"] = new_image

    output_path.write_text(
        json.dumps(request, indent=2),
        encoding="utf-8",
    )

    check = json.loads(output_path.read_text(encoding="utf-8"))

    for field in array_fields:
        value = check.get(field, [])

        if not isinstance(value, list):
            raise TypeError(
                f"Serialized {field} must be an array, "
                f"found {type(value).__name__}"
            )

    print(f"Old image: {old_image}")
    print(f"New image: {new_image}")
    print(f"Output: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())