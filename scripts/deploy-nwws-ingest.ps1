[CmdletBinding()]
param(
    [string]$Region = "us-east-1",
    [string]$Cluster = "zacharologistwx-live-alerts",
    [string]$Service = "zacharologistwx-nwws-ingest",
    [string]$EcrRepository = "zacharologistwx-nwws-ingest",
    [string]$ContainerName = "nwws-ingest",
    [string]$BuildContext = "services\nwws-ingest",
    [string]$HealthUrl = "https://zacharologistwx.com/api/live-alerts/current",

    [switch]$PlanOnly,
    [switch]$AllowDirty,
    [switch]$ForceBuild,
    [switch]$UseExistingImage,
    [switch]$NoPrompt,
    [switch]$SkipEndpointCheck,

    [ValidateRange(5, 300)]
    [int]$EndpointWaitSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Section {
    param([Parameter(Mandatory)][string]$Title)

    Write-Host ""
    Write-Host $Title -ForegroundColor Cyan
}

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found."
    }
}

function Invoke-NativeJson {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $Raw = & $Command @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }

    $Text = $Raw | Out-String

    if ([string]::IsNullOrWhiteSpace($Text)) {
        throw "$Command returned no JSON output."
    }

    return $Text | ConvertFrom-Json
}

function Get-PythonCommand {
    foreach ($Candidate in @("py", "python", "python3")) {
        if (Get-Command $Candidate -ErrorAction SilentlyContinue) {
            return $Candidate
        }
    }

    throw "Python was not found. Install Python or make py/python available in PATH."
}

function Ensure-DockerReady {
    docker info *> $null

    if ($LASTEXITCODE -eq 0) {
        return
    }

    $Candidates = @(
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
    )

    $DockerDesktop = $Candidates |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1

    if (-not $DockerDesktop) {
        throw "Docker is not running, and Docker Desktop could not be found."
    }

    Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
    Start-Process -FilePath $DockerDesktop

    foreach ($Attempt in 1..60) {
        Start-Sleep -Seconds 3
        docker info *> $null

        if ($LASTEXITCODE -eq 0) {
            Write-Host "Docker is ready." -ForegroundColor Green
            return
        }
    }

    throw "Docker Desktop did not become ready within three minutes."
}

function Get-LiveAlertSnapshot {
    param([Parameter(Mandatory)][string]$Url)

    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    $Response = Invoke-WebRequest `
        -Uri $Url `
        -UseBasicParsing `
        -Headers @{
            "Cache-Control" = "no-cache"
            "Pragma"        = "no-cache"
        }

    $Stopwatch.Stop()

    if ($Response.StatusCode -ne 200) {
        throw "Health endpoint returned HTTP $($Response.StatusCode)."
    }

    $Data = $Response.Content | ConvertFrom-Json

    if ($Data.type -ne "FeatureCollection") {
        throw "Health endpoint did not return a FeatureCollection."
    }

    $Features = @($Data.features)
    $GeneratedAt = $null
    $AgeSeconds = $null

    if (-not [string]::IsNullOrWhiteSpace([string]$Data.generatedAt)) {
        $GeneratedAt = [DateTimeOffset]::Parse([string]$Data.generatedAt)
        $AgeSeconds = [math]::Round(
            ([DateTimeOffset]::UtcNow - $GeneratedAt).TotalSeconds,
            1
        )
    }

    return [pscustomobject]@{
        CheckedAt    = [DateTimeOffset]::Now
        HttpStatus   = [int]$Response.StatusCode
        ResponseMs   = $Stopwatch.ElapsedMilliseconds
        Sequence     = [long]$Data.sequence
        GeneratedAt  = $GeneratedAt
        AgeSeconds   = $AgeSeconds
        AlertCount   = $Features.Count
        WithGeometry = @(
            $Features | Where-Object { $null -ne $_.geometry }
        ).Count
        WithStates   = @(
            $Features |
                Where-Object {
                    @(
                        $_.properties.states |
                            Where-Object {
                                -not [string]::IsNullOrWhiteSpace([string]$_)
                            }
                    ).Count -gt 0
                }
        ).Count
    }
}

Assert-Command "git"
Assert-Command "aws"

$RepoRootRaw = & git rev-parse --show-toplevel

if ($LASTEXITCODE -ne 0) {
    throw "This command must be run inside the Git repository."
}

$RepoRoot = ($RepoRootRaw | Select-Object -First 1).Trim()
Set-Location $RepoRoot

$GitStatus = @(& git status --porcelain)

if ($LASTEXITCODE -ne 0) {
    throw "Unable to read Git status."
}

if ($GitStatus.Count -gt 0) {
    if (-not ($PlanOnly -and $AllowDirty)) {
        Write-Host ""
        $GitStatus | ForEach-Object { Write-Host $_ }
        throw "The repository is not clean. Commit or discard changes before deploying."
    }

    Write-Host "Plan-only mode is allowing a dirty working tree." -ForegroundColor Yellow
}

$FullCommit = (& git rev-parse HEAD | Select-Object -First 1).Trim()
$CommitTag = (& git rev-parse --short=12 HEAD | Select-Object -First 1).Trim()
$BuildContextPath = Join-Path $RepoRoot $BuildContext

if (-not (Test-Path $BuildContextPath -PathType Container)) {
    throw "Build context was not found: $BuildContextPath"
}

Write-Section "AWS IDENTITY"

$Identity = Invoke-NativeJson "aws" @(
    "sts", "get-caller-identity",
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

[pscustomobject]@{
    Account = $Identity.Account
    Arn     = $Identity.Arn
    Region  = $Region
} | Format-List

Write-Section "CURRENT ECS SERVICE"

$ServiceInfo = (
    Invoke-NativeJson "aws" @(
        "ecs", "describe-services",
        "--cluster", $Cluster,
        "--services", $Service,
        "--region", $Region,
        "--output", "json",
        "--no-cli-pager"
    )
).services[0]

if (-not $ServiceInfo) {
    throw "The ECS service was not found."
}

if ($ServiceInfo.status -ne "ACTIVE") {
    throw "The ECS service is not ACTIVE."
}

if ($ServiceInfo.deploymentController.type -ne "ECS") {
    throw "This script supports the ECS rolling deployment controller only."
}

if (
    $ServiceInfo.desiredCount -lt 1 -or
    $ServiceInfo.runningCount -ne $ServiceInfo.desiredCount -or
    $ServiceInfo.pendingCount -ne 0
) {
    throw "The service is not currently stable."
}

$CurrentTaskDefinitionArn = [string]$ServiceInfo.taskDefinition

$CurrentTaskResponse = Invoke-NativeJson "aws" @(
    "ecs", "describe-task-definition",
    "--task-definition", $CurrentTaskDefinitionArn,
    "--include", "TAGS",
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

$CurrentTaskDefinition = $CurrentTaskResponse.taskDefinition

$CurrentContainer = @(
    $CurrentTaskDefinition.containerDefinitions |
        Where-Object { $_.name -eq $ContainerName }
)

if ($CurrentContainer.Count -ne 1) {
    throw "Expected exactly one '$ContainerName' container definition."
}

$CpuArchitecture = [string]$CurrentTaskDefinition.runtimePlatform.cpuArchitecture
$OperatingSystem = [string]$CurrentTaskDefinition.runtimePlatform.operatingSystemFamily

if ([string]::IsNullOrWhiteSpace($CpuArchitecture)) {
    $CpuArchitecture = "X86_64"
}

if ([string]::IsNullOrWhiteSpace($OperatingSystem)) {
    $OperatingSystem = "LINUX"
}

switch ($CpuArchitecture.ToUpperInvariant()) {
    "X86_64" { $DockerPlatform = "linux/amd64" }
    "ARM64"  { $DockerPlatform = "linux/arm64" }
    default  { throw "Unsupported ECS CPU architecture: $CpuArchitecture" }
}

if ($OperatingSystem.ToUpperInvariant() -ne "LINUX") {
    throw "Only Linux ECS task definitions are supported."
}

$RunningTaskArns = @(
    (
        Invoke-NativeJson "aws" @(
            "ecs", "list-tasks",
            "--cluster", $Cluster,
            "--service-name", $Service,
            "--desired-status", "RUNNING",
            "--region", $Region,
            "--output", "json",
            "--no-cli-pager"
        )
    ).taskArns
)

if ($RunningTaskArns.Count -ne $ServiceInfo.desiredCount) {
    throw "Running task count does not match desired count."
}

$DescribeRunningTaskArguments = @(
    "ecs", "describe-tasks",
    "--cluster", $Cluster,
    "--tasks"
) + $RunningTaskArns + @(
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

$RunningTasks = (
    Invoke-NativeJson "aws" $DescribeRunningTaskArguments
).tasks

$RunningContainerDigests = @(
    @(
        foreach ($Task in $RunningTasks) {
            $Container = @(
                $Task.containers |
                    Where-Object { $_.name -eq $ContainerName }
            )[0]

            if (-not $Container) {
                throw "Running task does not contain '$ContainerName'."
            }

            [string]$Container.imageDigest
        }
    ) | Select-Object -Unique
)

if ($RunningContainerDigests.Count -ne 1) {
    throw "Running tasks do not share one image digest."
}

$CurrentRunningDigest = $RunningContainerDigests[0]

$RepoInfo = (
    Invoke-NativeJson "aws" @(
        "ecr", "describe-repositories",
        "--repository-names", $EcrRepository,
        "--region", $Region,
        "--output", "json",
        "--no-cli-pager"
    )
).repositories[0]

$RepositoryUri = [string]$RepoInfo.repositoryUri
$RegistryUri = ($RepositoryUri -split "/")[0]
$TaggedImageUri = "${RepositoryUri}:${CommitTag}"

$ApplicationPaths = @(
    "services/nwws-ingest/Dockerfile",
    "services/nwws-ingest/.dockerignore",
    "services/nwws-ingest/requirements.txt",
    "services/nwws-ingest/src"
)

$StopBeforeBuild = $false
$ProductionCommit = $null
$ApplicationChanges = @()

Write-Section "NWWS APPLICATION CHANGE CHECK"

$RunningImageDetails = @(
    (
        Invoke-NativeJson "aws" @(
            "ecr", "describe-images",
            "--repository-name", $EcrRepository,
            "--image-ids", "imageDigest=$CurrentRunningDigest",
            "--region", $Region,
            "--output", "json",
            "--no-cli-pager"
        )
    ).imageDetails
)

$RunningImageDetail = $RunningImageDetails |
    Select-Object -First 1

$RunningImageTags = @()

if ($RunningImageDetail) {
    $RunningImageTags = @(
        $RunningImageDetail.imageTags |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace([string]$_)
            }
    )
}

$CommitLikeImageTags = @(
    $RunningImageTags |
        Where-Object {
            [string]$_ -match "^[0-9a-fA-F]{7,40}$"
        }
)

$ResolvedRunningCommits = @(
    @(
        foreach ($ImageTag in $CommitLikeImageTags) {
            $ResolvedCommitOutput = @(
                & git rev-parse `
                    --verify `
                    "${ImageTag}^{commit}" `
                    2>$null
            )

            if (
                $LASTEXITCODE -eq 0 -and
                $ResolvedCommitOutput.Count -gt 0
            ) {
                $ResolvedCommitOutput[0].Trim()
            }
        }
    ) | Sort-Object -Unique
)

if ($ResolvedRunningCommits.Count -eq 1) {
    $ProductionCommit = $ResolvedRunningCommits[0]

    Write-Host (
        "Running image tags: {0}" -f (
            ($RunningImageTags | Sort-Object -Unique) -join ", "
        )
    )
    Write-Host "Production commit: $ProductionCommit"
    Write-Host "Current commit:    $FullCommit"
    Write-Host ""

    $ApplicationDiffArguments = @(
        "diff",
        "--name-status",
        "--find-renames",
        $ProductionCommit,
        $FullCommit,
        "--"
    ) + $ApplicationPaths

    $ApplicationChanges = @(
        & git @ApplicationDiffArguments
    )

    if ($LASTEXITCODE -ne 0) {
        throw "Unable to compare production NWWS inputs against the current commit."
    }

    if ($ApplicationChanges.Count -gt 0) {
        Write-Host "Deployable NWWS application files changed:" -ForegroundColor Yellow

        $ApplicationChanges |
            ForEach-Object {
                Write-Host "  $_"
            }
    } else {
        Write-Host "No NWWS application changes detected." -ForegroundColor Green

        if ($ForceBuild) {
            Write-Host (
                "ForceBuild was specified. Continuing without requiring NWWS application changes."
            ) -ForegroundColor Yellow
        } else {
            $StopBeforeBuild = $true
        }
    }
} else {
    if ($ResolvedRunningCommits.Count -gt 1) {
        $ResolutionMessage = (
            "The running production image tags resolved to multiple Git commits."
        )
    } else {
        $ResolutionMessage = (
            "Could not determine the Git commit represented by the running production image."
        )
    }

    if (-not $ForceBuild) {
        throw (
            "$ResolutionMessage " +
            "No Docker or AWS write operations were performed. " +
            "Use -ForceBuild only for an intentional rebuild."
        )
    }

    Write-Host (
        "$ResolutionMessage ForceBuild was specified, so the build may continue."
    ) -ForegroundColor Yellow
}

$RollbackCommand = @(
    ('aws ecs update-service --cluster "{0}" --service "{1}" --task-definition "{2}" --region "{3}"' -f $Cluster, $Service, $CurrentTaskDefinitionArn, $Region)
    ('aws ecs wait services-stable --cluster "{0}" --services "{1}" --region "{2}"' -f $Cluster, $Service, $Region)
) -join [Environment]::NewLine

[pscustomobject]@{
    RepositoryRoot       = $RepoRoot
    Commit               = $FullCommit
    CommitTag            = $CommitTag
    BuildContext         = $BuildContextPath
    DockerPlatform       = $DockerPlatform
    Cluster              = $Cluster
    Service              = $Service
    Desired              = $ServiceInfo.desiredCount
    Running              = $ServiceInfo.runningCount
    Pending              = $ServiceInfo.pendingCount
    CurrentTaskDefinition = $CurrentTaskDefinitionArn
    CurrentImage         = $CurrentContainer[0].image
    CurrentDigest        = $CurrentRunningDigest
    RollbackTarget       = $CurrentTaskDefinitionArn
    NewImageTag          = $TaggedImageUri
} | Format-List

Write-Section "ROLLBACK COMMAND"

Write-Host $RollbackCommand -ForegroundColor Yellow

if ($PlanOnly) {
    Write-Host ""
    Write-Host "PLAN ONLY COMPLETE - no AWS or Docker changes were made." -ForegroundColor Green
    return
}

if ($StopBeforeBuild) {
    Write-Host ""
    Write-Host "BUILD SKIPPED - no Docker, ECR image, or ECS task-definition changes were made." -ForegroundColor Green
    return
}

Assert-Command "docker"
$PythonCommand = Get-PythonCommand

Ensure-DockerReady

Write-Section "ECR IMAGE LOOKUP"

$ExistingLookup = Invoke-NativeJson "aws" @(
    "ecr", "batch-get-image",
    "--repository-name", $EcrRepository,
    "--image-ids", "imageTag=$CommitTag",
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

$ExistingImage = @($ExistingLookup.images) | Select-Object -First 1
$NewImageDigest = $null

if ($ExistingImage) {
    $NewImageDigest = [string]$ExistingImage.imageId.imageDigest

    if (-not $UseExistingImage) {
        $ExistingImageMessage = (
            "The immutable ECR tag '{0}' already exists.{1}{1}" +
            "Rerun with -UseExistingImage only if you intentionally want to deploy that existing image."
        ) -f $CommitTag, [Environment]::NewLine

        throw $ExistingImageMessage
    }

    Write-Host "Using existing immutable image: $TaggedImageUri" -ForegroundColor Yellow
    Write-Host "Digest: $NewImageDigest"
} else {
    Write-Section "ECR LOGIN"

    $LoginPassword = & aws ecr get-login-password --region $Region

    if ($LASTEXITCODE -ne 0) {
        throw "Unable to obtain an ECR login password."
    }

    $LoginPassword |
        & docker login `
            --username AWS `
            --password-stdin $RegistryUri

    $LoginPassword = $null

    if ($LASTEXITCODE -ne 0) {
        throw "Docker login to ECR failed."
    }

    Write-Section "BUILDING IMAGE"

    & docker buildx build `
        --platform $DockerPlatform `
        --pull `
        --load `
        --tag $TaggedImageUri `
        $BuildContextPath

    if ($LASTEXITCODE -ne 0) {
        throw "Docker image build failed."
    }

    Write-Section "CONTAINER PYTHON CHECK"

    & docker run `
        --rm `
        --entrypoint python `
        $TaggedImageUri `
        -m py_compile /app/src/nwws_ingest.py

    if ($LASTEXITCODE -ne 0) {
        throw "Python syntax validation failed inside the container."
    }

    Write-Host "Container Python check passed." -ForegroundColor Green

    Write-Section "PUSHING IMMUTABLE IMAGE"

    & docker push $TaggedImageUri

    if ($LASTEXITCODE -ne 0) {
        throw "Docker push failed."
    }

    $PushedImage = (
        Invoke-NativeJson "aws" @(
            "ecr", "describe-images",
            "--repository-name", $EcrRepository,
            "--image-ids", "imageTag=$CommitTag",
            "--region", $Region,
            "--output", "json",
            "--no-cli-pager"
        )
    ).imageDetails[0]

    $NewImageDigest = [string]$PushedImage.imageDigest
}

if ([string]::IsNullOrWhiteSpace($NewImageDigest)) {
    throw "Could not resolve the new ECR image digest."
}

$PinnedImageUri = "${RepositoryUri}@${NewImageDigest}"

Write-Section "CREATING TASK DEFINITION"

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ArchiveRoot = Join-Path $RepoRoot "_local-archive"
$WorkDirectory = Join-Path $ArchiveRoot "nwws-deploy-$Timestamp"

New-Item -ItemType Directory -Force $WorkDirectory | Out-Null

$SourcePath = Join-Path $WorkDirectory "source-task-definition.json"
$RequestPath = Join-Path $WorkDirectory "deploy-task-definition.json"
$GeneratorPath = Join-Path $RepoRoot "scripts\make-nwws-task-definition.py"

$SourceJson = $CurrentTaskResponse | ConvertTo-Json -Depth 100

[System.IO.File]::WriteAllText(
    $SourcePath,
    $SourceJson,
    [System.Text.UTF8Encoding]::new($false)
)

if (-not (Test-Path $GeneratorPath -PathType Leaf)) {
    throw "Task-definition helper was not found: $GeneratorPath"
}

& $PythonCommand `
    $GeneratorPath `
    $SourcePath `
    $RequestPath `
    $ContainerName `
    $PinnedImageUri

if ($LASTEXITCODE -ne 0) {
    throw "Task-definition JSON generation failed."
}

Push-Location $WorkDirectory

try {
    $RegisterOutput = & aws ecs register-task-definition `
        --cli-input-json "file://deploy-task-definition.json" `
        --region $Region `
        --output json `
        --no-cli-pager

    if ($LASTEXITCODE -ne 0) {
        throw "Task-definition registration failed."
    }
} finally {
    Pop-Location
}

$RegisteredTask = (
    ($RegisterOutput | Out-String) |
    ConvertFrom-Json
).taskDefinition

$NewTaskDefinitionArn = [string]$RegisteredTask.taskDefinitionArn

if ([string]::IsNullOrWhiteSpace($NewTaskDefinitionArn)) {
    throw "AWS did not return a new task-definition ARN."
}

$RegisteredContainer = @(
    $RegisteredTask.containerDefinitions |
        Where-Object { $_.name -eq $ContainerName }
)

if ($RegisteredContainer.Count -ne 1) {
    throw "Registered task definition has the wrong container layout."
}

if ($RegisteredContainer[0].image -ne $PinnedImageUri) {
    throw "Registered task definition contains the wrong image."
}

Write-Section "DEPLOYMENT READY"

[pscustomobject]@{
    PreviousTaskDefinition = $CurrentTaskDefinitionArn
    NewTaskDefinition      = $NewTaskDefinitionArn
    NewImageTag            = $TaggedImageUri
    NewPinnedImage         = $PinnedImageUri
    NewDigest              = $NewImageDigest
    RollbackTarget         = $CurrentTaskDefinitionArn
} | Format-List

Write-Section "ROLLBACK COMMAND"

Write-Host $RollbackCommand -ForegroundColor Yellow

if (-not $NoPrompt) {
    $Answer = Read-Host "Type DEPLOY to update the live ECS service"

    if ($Answer -cne "DEPLOY") {
        Write-Host ""
        Write-Host "Deployment cancelled. The image and task definition remain registered." -ForegroundColor Yellow
        return
    }
}

Write-Section "UPDATING ECS SERVICE"

$UpdateResult = Invoke-NativeJson "aws" @(
    "ecs", "update-service",
    "--cluster", $Cluster,
    "--service", $Service,
    "--task-definition", $NewTaskDefinitionArn,
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

$UpdateResult.service.deployments |
    Select-Object `
        status,
        taskDefinition,
        desiredCount,
        pendingCount,
        runningCount,
        rolloutState |
    Format-Table -AutoSize -Wrap

Write-Section "WAITING FOR SERVICE STABILITY"

& aws ecs wait services-stable `
    --cluster $Cluster `
    --services $Service `
    --region $Region `
    --no-cli-pager

if ($LASTEXITCODE -ne 0) {
    $FailedService = (
        Invoke-NativeJson "aws" @(
            "ecs", "describe-services",
            "--cluster", $Cluster,
            "--services", $Service,
            "--region", $Region,
            "--output", "json",
            "--no-cli-pager"
        )
    ).services[0]

    Write-Section "FAILED DEPLOYMENT STATE"

    $FailedService.deployments |
        Select-Object `
            status,
            taskDefinition,
            desiredCount,
            pendingCount,
            runningCount,
            failedTasks,
            rolloutState,
            rolloutStateReason |
        Format-Table -AutoSize -Wrap

    Write-Section "RECENT SERVICE EVENTS"

    $FailedService.events |
        Select-Object -First 15 createdAt, message |
        Format-Table -AutoSize -Wrap

    Write-Section "ROLLBACK COMMAND"

    Write-Host $RollbackCommand -ForegroundColor Red

    throw "The ECS deployment did not stabilize."
}

Write-Section "VERIFYING RUNNING DEPLOYMENT"

$FinalService = (
    Invoke-NativeJson "aws" @(
        "ecs", "describe-services",
        "--cluster", $Cluster,
        "--services", $Service,
        "--region", $Region,
        "--output", "json",
        "--no-cli-pager"
    )
).services[0]

if ($FinalService.taskDefinition -ne $NewTaskDefinitionArn) {
    throw "The ECS service is not using the new task definition."
}

if (
    $FinalService.runningCount -ne $FinalService.desiredCount -or
    $FinalService.pendingCount -ne 0
) {
    throw "The ECS service is not stable after deployment."
}

$FinalTaskArns = @(
    (
        Invoke-NativeJson "aws" @(
            "ecs", "list-tasks",
            "--cluster", $Cluster,
            "--service-name", $Service,
            "--desired-status", "RUNNING",
            "--region", $Region,
            "--output", "json",
            "--no-cli-pager"
        )
    ).taskArns
)

if ($FinalTaskArns.Count -ne $FinalService.desiredCount) {
    throw "Final running task count does not match desired count."
}

$DescribeFinalTaskArguments = @(
    "ecs", "describe-tasks",
    "--cluster", $Cluster,
    "--tasks"
) + $FinalTaskArns + @(
    "--region", $Region,
    "--output", "json",
    "--no-cli-pager"
)

$FinalTasks = (
    Invoke-NativeJson "aws" $DescribeFinalTaskArguments
).tasks

foreach ($Task in $FinalTasks) {
    if ($Task.taskDefinitionArn -ne $NewTaskDefinitionArn) {
        throw "A running task is not using the new task definition."
    }

    $Container = @(
        $Task.containers |
            Where-Object { $_.name -eq $ContainerName }
    )[0]

    if (-not $Container) {
        throw "A running task does not contain '$ContainerName'."
    }

    if ($Container.imageDigest -ne $NewImageDigest) {
        throw "A running container has the wrong image digest."
    }

    if ($Container.lastStatus -ne "RUNNING") {
        throw "A replacement container is not RUNNING."
    }
}

[pscustomobject]@{
    TaskDefinition  = $NewTaskDefinitionArn
    Desired         = $FinalService.desiredCount
    Running         = $FinalService.runningCount
    Pending         = $FinalService.pendingCount
    Image            = $PinnedImageUri
    ImageDigest      = $NewImageDigest
    DigestVerified   = $true
    RollbackTarget   = $CurrentTaskDefinitionArn
} | Format-List

Write-Section "CLOUDWATCH LOG CHECK"

$FinalTaskDefinition = (
    Invoke-NativeJson "aws" @(
        "ecs", "describe-task-definition",
        "--task-definition", $NewTaskDefinitionArn,
        "--region", $Region,
        "--output", "json",
        "--no-cli-pager"
    )
).taskDefinition

$FinalContainerDefinition = @(
    $FinalTaskDefinition.containerDefinitions |
        Where-Object { $_.name -eq $ContainerName }
)[0]

$LogConfiguration = $FinalContainerDefinition.logConfiguration

if ($LogConfiguration -and $LogConfiguration.logDriver -eq "awslogs") {
    $LogGroup = [string]$LogConfiguration.options.'awslogs-group'
    $LogRegion = [string]$LogConfiguration.options.'awslogs-region'
    $LogPrefix = [string]$LogConfiguration.options.'awslogs-stream-prefix'

    if ([string]::IsNullOrWhiteSpace($LogRegion)) {
        $LogRegion = $Region
    }

    $PrimaryTask = $FinalTasks[0]
    $TaskId = ([string]$PrimaryTask.taskArn -split "/")[-1]
    $LogStream = "$LogPrefix/$ContainerName/$TaskId"
    $StartTime = [DateTimeOffset]::UtcNow.AddMinutes(-20).ToUnixTimeMilliseconds()

    $LogResult = Invoke-NativeJson "aws" @(
        "logs", "filter-log-events",
        "--log-group-name", $LogGroup,
        "--log-stream-names", $LogStream,
        "--start-time", [string]$StartTime,
        "--region", $LogRegion,
        "--output", "json",
        "--no-cli-pager"
    )

    $LogEvents = @($LogResult.events)

    if ($LogEvents.Count -eq 0) {
        Write-Host "No CloudWatch log events were returned yet." -ForegroundColor Yellow
    } else {
        $LogEvents |
            Select-Object -Last 40 |
            Select-Object `
                @{
                    Name = "Time"
                    Expression = {
                        [DateTimeOffset]::FromUnixTimeMilliseconds(
                            [long]$_.timestamp
                        ).LocalDateTime
                    }
                },
                message |
            Format-Table -AutoSize -Wrap
    }

    $ErrorLikeEvents = @(
        $LogEvents |
            Where-Object {
                $_.message -match "(?i)\b(error|exception|traceback|fatal)\b"
            }
    )

    [pscustomobject]@{
        LogGroup      = $LogGroup
        LogStream     = $LogStream
        LogEvents     = $LogEvents.Count
        ErrorLikeLogs = $ErrorLikeEvents.Count
    } | Format-List

    if ($ErrorLikeEvents.Count -gt 0) {
        Write-Host "Review the error-like log lines above." -ForegroundColor Yellow
    }
} else {
    Write-Host "The task definition does not use the awslogs driver." -ForegroundColor Yellow
}

if (-not $SkipEndpointCheck) {
    Write-Section "LIVE ENDPOINT CHECK"

    $FirstSnapshot = Get-LiveAlertSnapshot -Url $HealthUrl

    Write-Host "Waiting $EndpointWaitSeconds seconds for a second snapshot..."
    Start-Sleep -Seconds $EndpointWaitSeconds

    $SecondSnapshot = Get-LiveAlertSnapshot -Url $HealthUrl

    [pscustomobject]@{
        FirstSequence      = $FirstSnapshot.Sequence
        SecondSequence     = $SecondSnapshot.Sequence
        SequenceDifference = (
            $SecondSnapshot.Sequence - $FirstSnapshot.Sequence
        )
        SequenceAdvanced   = (
            $SecondSnapshot.Sequence -gt $FirstSnapshot.Sequence
        )
        GeneratedAt        = $SecondSnapshot.GeneratedAt
        AgeSeconds         = $SecondSnapshot.AgeSeconds
        HttpStatus         = $SecondSnapshot.HttpStatus
        ResponseMs         = $SecondSnapshot.ResponseMs
        CurrentAlerts      = $SecondSnapshot.AlertCount
        AlertsWithGeometry = $SecondSnapshot.WithGeometry
        AlertsWithStates   = $SecondSnapshot.WithStates
    } | Format-List
}

Write-Section "DEPLOYMENT COMPLETE"

[pscustomobject]@{
    Commit             = $FullCommit
    CommitTag          = $CommitTag
    TaskDefinition     = $NewTaskDefinitionArn
    ImageDigest        = $NewImageDigest
    ServiceRunning     = $FinalService.runningCount
    ServicePending     = $FinalService.pendingCount
    RollbackTarget     = $CurrentTaskDefinitionArn
} | Format-List

Write-Section "ROLLBACK COMMAND"

Write-Host $RollbackCommand -ForegroundColor Yellow
