# NWWS-OI Ingest Deployment

The NWWS-OI ingest service runs on AWS ECS/Fargate.

## Deployment resources

- AWS region: `us-east-1`
- ECS cluster: `zacharologistwx-live-alerts`
- ECS service: `zacharologistwx-nwws-ingest`
- ECR repository: `zacharologistwx-nwws-ingest`
- Container name: `nwws-ingest`
- Build context: `services/nwws-ingest`

## Prerequisites

The deployment workstation needs:

- Git
- AWS CLI with access to ECS, ECR, CloudWatch Logs, and STS
- Docker Desktop using Linux containers
- Python
- A clean Git working tree

The script builds for the CPU architecture configured by the current ECS task definition.

## Read-only deployment plan

Run this before every deployment:

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1 `
    -PlanOnly
```

The plan reads Git, ECS, ECR, and the currently running task. It does not build, push, register, or deploy anything.

While initially developing the script, a dirty-tree plan may be run with:

```powershell
-AllowDirty
```

`-AllowDirty` is accepted only with `-PlanOnly`. Live deployments require a clean repository.

## Deploy the current commit

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1
```

Before changing the ECS service, the script prints the new task definition and asks for the exact confirmation:

```text
DEPLOY
```

The script then:

1. Validates the repository and AWS identity.
2. Reads the current ECS service and running image digest.
3. Builds a Linux image tagged with the Git commit.
4. Tests Python syntax inside the container.
5. Pushes the immutable commit tag to ECR.
6. Registers a task definition pinned to the ECR SHA-256 digest.
7. Updates the ECS service.
8. Waits for service stability.
9. Verifies the running task definition and digest.
10. Checks CloudWatch logs and the live alert endpoint.
11. Prints the rollback command.

## Existing immutable image

If the current commit tag already exists in ECR and it is intentionally being reused:

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1 `
    -UseExistingImage
```

The script refuses to overwrite an existing commit tag.

## Unattended confirmation

`-NoPrompt` skips the `DEPLOY` confirmation. Use it only in a trusted automated workflow after the plan has been reviewed.

## Optional checks

Skip the live endpoint comparison:

```powershell
-SkipEndpointCheck
```

Change the delay between endpoint snapshots:

```powershell
-EndpointWaitSeconds 60
```

## Rollback

The deployment script treats the task definition active before deployment as the rollback target and prints exact rollback commands.

The standard rollback pattern is:

```powershell
aws ecs update-service `
    --cluster "zacharologistwx-live-alerts" `
    --service "zacharologistwx-nwws-ingest" `
    --task-definition "<previous-task-definition-arn>" `
    --region "us-east-1"

aws ecs wait services-stable `
    --cluster "zacharologistwx-live-alerts" `
    --services "zacharologistwx-nwws-ingest" `
    --region "us-east-1"
```

Always use the rollback target printed for that specific deployment.

## Safety rules

- Do not deploy from a dirty working tree.
- Do not overwrite immutable commit tags.
- Do not rely on the mutable `latest` tag for a production deployment.
- Keep generated deployment JSON under `_local-archive`.
- Do not commit credentials, tokens, manifests containing secrets, or local archive files.
- Review CloudWatch logs and the live endpoint after every deployment.