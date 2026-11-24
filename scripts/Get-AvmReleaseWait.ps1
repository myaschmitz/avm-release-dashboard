<#
.SYNOPSIS
    Rebuilds, from git history, how long human commits wait between landing on the
    default branch and appearing in a version tag.

.DESCRIPTION
    Writes two weekly series, both in days:

      waiting   On each sample date, the age of every human commit that had landed
                but was not yet in any version tag. This drops when a backlog is
                released.
      shipped   For commits first tagged in the window ending on each sample date,
                the time from landing to that tag. This drops when new work is
                released quickly.

    Unlike history.json, nothing here needs committing. Every input is a commit
    date, a tag, or a release date, and git keeps all of them, so any past day can
    be recomputed. That is what gives the series a baseline from before any
    release automation existed.

    Commits that shipped in a repository's first version are left out. They are
    the module's initial development, not work waiting on a release.

    Each repository is cloned bare without file contents, which takes about a
    second and costs no REST API quota. One API call per repository reads release
    publication dates.
#>
[CmdletBinding()]
param(
    [string]$Owner = 'Azure',
    [string]$StatusPath = "$PSScriptRoot/../site/data/release-status.json",
    [string]$OutputPath = "$PSScriptRoot/../site/data/release-wait.json",
    [datetime]$Since = '2024-01-01',
    [int]$StepDays = 7,
    [int]$WindowDays = 28,
    [int]$ThrottleLimit = 8,
    [int]$MaxRepos = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $StatusPath)) { throw "No status file at $StatusPath. Run Get-AvmReleaseStatus.ps1 first." }

# The status sweep already found every live repository and which ones carry a
# version tag. A repository with no tag has nothing to measure, so it is not cloned.
$status = Get-Content $StatusPath -Raw | ConvertFrom-Json
$repoNames = @($status.modules | Where-Object { $_.state -ne 'never-released' } | ForEach-Object repo | Sort-Object -Unique)
if ($MaxRepos -gt 0) { $repoNames = @($repoNames | Select-Object -First $MaxRepos) }
Write-Host "Measuring $($repoNames.Count) repositories"

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("avm-release-wait-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workRoot | Out-Null

try {
    $results = $repoNames | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
        $name = $_
        $full = "$($using:Owner)/$name"
        $dir = Join-Path $using:workRoot "$name.git"

        # --git-dir is passed on every call, because some git configurations refuse
        # to discover a bare repository from the working directory.
        function Invoke-Git { & git --git-dir=$dir @args 2>$null }

        & git clone --quiet --bare --filter=blob:none "https://github.com/$full.git" $dir 2>$null
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ repo = $name; error = 'clone failed'; landed = @(); released = @() }
        }

        try {
            # The registry publishes when a tag is pushed. Most AVM tags are
            # lightweight, so git does not record when that happened. A GitHub release
            # created alongside the tag does, so its date is preferred.
            $published = @{}
            $lines = & gh api "repos/$full/releases?per_page=100" --paginate --jq '.[] | select(.draft | not) | "\(.tag_name)\t\(.published_at)"' 2>$null
            foreach ($line in @($lines)) {
                $parts = "$line" -split "`t"
                if ($parts.Count -eq 2 -and $parts[1]) {
                    $published[$parts[0]] = ([DateTimeOffset]::Parse($parts[1])).ToUnixTimeSeconds()
                }
            }

            $tags = foreach ($line in @(Invoke-Git for-each-ref refs/tags --format='%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(committerdate:unix)%09%(*committerdate:unix)%09%(taggerdate:unix)')) {
                $f = "$line" -split "`t"
                # Same filter as the status sweep: the registry ignores pre-releases.
                if ($f[0] -notmatch '^v?\d+\.\d+\.\d+$') { continue }
                $annotated = $f[1] -eq 'tag'
                $sha = if ($annotated) { $f[3] } else { $f[2] }
                $when = if ($published.ContainsKey($f[0])) { $published[$f[0]] }
                elseif ($annotated -and $f[6]) { [long]$f[6] }
                elseif ($annotated) { [long]$f[5] }
                else { [long]$f[4] }
                [pscustomobject]@{ Sha = $sha; When = [long]$when }
            }
            $tags = @($tags | Sort-Object When)
            if ($tags.Count -eq 0) {
                return [pscustomobject]@{ repo = $name; error = $null; landed = @(); released = @() }
            }

            # A commit is released at the earliest tag that contains it. Walking tags
            # in release order and excluding everything earlier tags already contained
            # assigns each commit exactly once.
            $releasedAt = @{}
            $firstTagged = [System.Collections.Generic.HashSet[string]]::new()
            $earlier = [System.Collections.Generic.List[string]]::new()
            foreach ($tag in $tags) {
                $range = @($tag.Sha) + @($earlier | ForEach-Object { "^$_" })
                foreach ($sha in @(Invoke-Git rev-list @range)) {
                    if (-not $releasedAt.ContainsKey($sha)) {
                        $releasedAt[$sha] = $tag.When
                        if ($earlier.Count -eq 0) { [void]$firstTagged.Add($sha) }
                    }
                }
                $earlier.Add($tag.Sha)
            }

            # First parent only. On a squash or rebase merge, the commit on the default
            # branch carries the time it landed. Following a merge commit's second
            # parent would instead report when the author first wrote each change.
            $landed = [System.Collections.Generic.List[long]]::new()
            $released = [System.Collections.Generic.List[long]]::new()
            foreach ($line in @(Invoke-Git log --first-parent --format='%H%x09%ct%x09%an%x09%ae' HEAD)) {
                $f = "$line" -split "`t"
                if ($f.Count -lt 4) { continue }
                # Author, not subject, separates people from automation. The same
                # rule as the status sweep, applied to the git identity.
                if ($f[2] -match '\[bot\]' -or $f[3] -match '\[bot\]') { continue }
                if ($firstTagged.Contains($f[0])) { continue }
                $landed.Add([long]$f[1])
                $released.Add($(if ($releasedAt.ContainsKey($f[0])) { [long]$releasedAt[$f[0]] } else { 0L }))
            }

            [pscustomobject]@{ repo = $name; error = $null; landed = $landed.ToArray(); released = $released.ToArray() }
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$failed = @($results | Where-Object { $_.error })
foreach ($f in $failed) { Write-Warning "$($f.repo): $($f.error)" }

$landedAll = [System.Collections.Generic.List[long]]::new()
$releasedAll = [System.Collections.Generic.List[long]]::new()
foreach ($r in $results) {
    $landedAll.AddRange([long[]]$r.landed)
    $releasedAll.AddRange([long[]]$r.released)
}
$landed = $landedAll.ToArray()
$released = $releasedAll.ToArray()
Write-Host "Collected $($landed.Count) human commits from $(@($results).Count - $failed.Count) repositories"

function Get-Summary {
    param([System.Collections.Generic.List[double]]$Days)
    if ($Days.Count -eq 0) { return [ordered]@{ count = 0; median = $null; p90 = $null; mean = $null } }
    $Days.Sort()
    $mid = [int][math]::Floor($Days.Count / 2)
    $median = if ($Days.Count % 2) { $Days[$mid] } else { ($Days[$mid - 1] + $Days[$mid]) / 2 }
    # Nearest rank. Most AVM releases tag the merge of the pull request that asked
    # for them, so the median released commit waited minutes. The slow tail is what
    # release automation can shorten, and the 90th percentile tracks it.
    $p90 = $Days[[math]::Max(0, [int][math]::Ceiling(0.9 * $Days.Count) - 1)]
    $sum = 0.0
    foreach ($d in $Days) { $sum += $d }
    return [ordered]@{
        count  = $Days.Count
        median = [math]::Round($median, 1)
        p90    = [math]::Round($p90, 1)
        mean   = [math]::Round($sum / $Days.Count, 1)
    }
}

# Sample dates step back from today, so the newest point is always the present.
$today = [DateTimeOffset]::UtcNow.Date
$dates = [System.Collections.Generic.List[datetime]]::new()
for ($d = $today; $d -ge $Since.Date; $d = $d.AddDays(-$StepDays)) { $dates.Insert(0, $d) }

$points = foreach ($date in $dates) {
    # The end of the sample day, so a commit that landed that day counts.
    $end = ([DateTimeOffset]::new($date.AddDays(1), [TimeSpan]::Zero)).ToUnixTimeSeconds()
    $windowStart = $end - ($WindowDays * 86400L)

    $waiting = [System.Collections.Generic.List[double]]::new()
    $shipped = [System.Collections.Generic.List[double]]::new()

    for ($i = 0; $i -lt $landed.Length; $i++) {
        $l = $landed[$i]
        if ($l -gt $end) { continue }
        $r = $released[$i]
        if ($r -eq 0 -or $r -gt $end) {
            $waiting.Add(($end - $l) / 86400.0)
        }
        elseif ($r -gt $windowStart) {
            # Committer dates can trail a tag by a little when a commit is amended,
            # so a negative wait is clamped rather than reported.
            $shipped.Add([math]::Max(0, ($r - $l) / 86400.0))
        }
    }

    [ordered]@{
        date    = $date.ToString('yyyy-MM-dd')
        waiting = Get-Summary -Days $waiting
        shipped = Get-Summary -Days $shipped
    }
}

$document = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    repoCount   = @($results).Count - $failed.Count
    failedRepos = @($failed | ForEach-Object repo)
    commitCount = $landed.Count
    stepDays    = $StepDays
    windowDays  = $WindowDays
    points      = @($points)
}

$directory = Split-Path -Parent $OutputPath
if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
[IO.File]::WriteAllText($OutputPath, ($document | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Host "Wrote $OutputPath with $(@($points).Count) points"
