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

While initially developing or testing the script, a dirty-tree plan may be run with:

```powershell
-AllowDirty
```

`-AllowDirty` is accepted only with `-PlanOnly`. Live deployments require a clean repository.

## Application-change guard

Before Docker is checked or started, the script compares the current committed tree with the Git commit represented by the running production image.

The script:

1. Reads the digest of the image running in ECS.
2. Looks up that digest in ECR.
3. Reads commit-like tags attached to the image.
4. Resolves those tags against the local Git history.
5. Compares the production commit with the current commit.

Older production images may use seven-character Git tags such as `81cb7ec`. Newer deployments use 12-character Git tags.

The following paths are treated as deployable NWWS application inputs:

- `services/nwws-ingest/Dockerfile`
- `services/nwws-ingest/.dockerignore`
- `services/nwws-ingest/requirements.txt`
- `services/nwws-ingest/src/**`

The script clearly lists every changed deployable file.

If none of these inputs differ from the running production commit, it prints:

```text
No NWWS application changes detected.
```

A normal run then exits before:

- Docker startup
- ECR login
- Image building
- Image pushing
- ECS task-definition registration
- ECS service updates

`-PlanOnly` performs the same comparison but always exits without Docker or AWS write operations.

If the production Git commit cannot be resolved unambiguously from the running image, the script fails closed before Docker unless `-ForceBuild` was explicitly supplied.

## Deploy the current commit

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1
```

When deployable application inputs changed, the script:

1. Validates the repository, clean working tree, and AWS identity.
2. Reads the current ECS service, task definition, and running image digest.
3. Resolves the running production image to its Git commit.
4. Compares the deployable NWWS application inputs with the current commit.
5. Stops before Docker if no application inputs changed.
6. Builds a Linux image tagged with the current Git commit.
7. Tests Python syntax inside the container.
8. Pushes the immutable commit tag to ECR.
9. Registers a task definition pinned to the ECR SHA-256 digest.
10. Prints the proposed task definition and rollback command.
11. Asks for the exact confirmation:

```text
DEPLOY
```

12. Updates the ECS service.
13. Waits for service stability.
14. Verifies the running task definition and digest.
15. Checks CloudWatch logs and the live alert endpoint.

**Important:** When deployable application changes exist, the script builds and pushes the image and registers a task definition before the `DEPLOY` prompt appears. The prompt controls whether the live ECS service is updated.

The application-change guard prevents those pre-confirmation writes when the current commit contains no NWWS application changes.

## Forced rebuild

A normal run stops when no deployable NWWS application inputs changed.

Use `-ForceBuild` only for a deliberate rebuild, such as intentionally refreshing the base image without changing application files:

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1 `
    -ForceBuild
```

`-ForceBuild` bypasses only the application-change guard.

It does not:

- Permit deployment from a dirty working tree
- Permit an immutable ECR commit tag to be overwritten
- Skip ECS service validation
- Skip architecture validation
- Skip running-image digest validation
- Skip the `DEPLOY` confirmation

A forced plan remains read-only:

```powershell
powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File .\scripts\deploy-nwws-ingest.ps1 `
    -PlanOnly `
    -ForceBuild
```

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

`-UseExistingImage` does not bypass the application-change guard. If no deployable NWWS application inputs differ from production, an intentional reuse also requires `-ForceBuild`.

## Unattended confirmation

`-NoPrompt` skips the `DEPLOY` confirmation.

Use it only in a trusted automated workflow after the plan and application-change list have been reviewed.

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
- Run `-PlanOnly` before every deployment.
- Review the application-change list before allowing a build to continue.
- Use `-ForceBuild` only for an intentional rebuild.
- Do not overwrite immutable commit tags.
- Do not rely on the mutable `latest` tag for a production deployment.
- Remember that a genuine application-change run builds, pushes, and registers its task definition before the `DEPLOY` prompt.
- Keep generated deployment JSON and local backups under `_local-archive`.
- Do not commit credentials, tokens, manifests containing secrets, or local archive files.
- Review CloudWatch logs and the live endpoint after every deployment.