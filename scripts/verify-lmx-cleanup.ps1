[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ApiKey,
  [string]$ClientName = "Acorn Construction",
  [switch]$SkipCreateDelete
)

$ErrorActionPreference = "Stop"
$baseUrl = "https://api.scalepad.com"
$headers = @{ "x-api-key" = $ApiKey; Accept = "application/json" }

function Invoke-Lmx {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("GET", "POST", "DELETE")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )

  $uri = "$baseUrl$Path"
  try {
    $invokeArgs = @{
      Method = $Method
      Uri = $uri
      Headers = $headers
      ContentType = "application/json"
      ErrorAction = "Stop"
    }
    if ($null -ne $Body) {
      $invokeArgs.Body = ($Body | ConvertTo-Json -Depth 30 -Compress)
    }
    return Invoke-RestMethod @invokeArgs
  } catch {
    $detail = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
    throw "$Method $Path failed: $detail"
  }
}

function Get-ItemsFromResponse($response) {
  if ($null -eq $response) { return @() }
  if ($response.data -is [System.Array]) { return @($response.data) }
  if ($response.data) { return @($response.data) }
  if ($response.items -is [System.Array]) { return @($response.items) }
  return @()
}

function Get-RecordId($item) {
  foreach ($candidate in @(
    $item.id,
    $item.goal_id,
    $item.meeting_id,
    $item.goal.id,
    $item.meeting.id,
    $item.data.id
  )) {
    if ($candidate) { return [string]$candidate }
  }
  return $null
}

function Get-NextCursor($response) {
  if ($response.next_cursor) { return [string]$response.next_cursor }
  if ($response.meta.next_cursor) { return [string]$response.meta.next_cursor }
  return $null
}

function Get-All($path) {
  $all = @()
  $cursor = $null
  do {
    $separator = if ($path.Contains("?")) { "&" } else { "?" }
    $pagePath = "$path${separator}page_size=100"
    if ($cursor) { $pagePath += "&cursor=$([uri]::EscapeDataString($cursor))" }
    $response = Invoke-Lmx -Method GET -Path $pagePath
    $all += @(Get-ItemsFromResponse $response)
    $cursor = Get-NextCursor $response
  } while ($cursor)
  return $all
}

$normalizedName = $ClientName.Trim().ToLowerInvariant()
Write-Host "Discovering Lifecycle Manager client '$ClientName'..."
$clientRecords = Get-All "/lifecycle-manager/v1/clients"
$clientRecord = $clientRecords | Where-Object {
  $nested = $_.client
  $name = if ($nested) { $nested.display_name } else { $_.display_name }
  ([string]$name).Trim().ToLowerInvariant() -eq $normalizedName
} | Select-Object -First 1

if (-not $clientRecord) { throw "Lifecycle Manager client '$ClientName' was not found." }
$lmxClientId = [string]$clientRecord.client.client_id
if ([string]::IsNullOrWhiteSpace($lmxClientId)) { throw "Client '$ClientName' did not include client.client_id in the LMX client response." }
Write-Host "Resolved LMX client ID: $lmxClientId"

$filterKey = [uri]::EscapeDataString("filter[client.id]")
$filter = [uri]::EscapeDataString("eq:$lmxClientId")
$goalsPath = "/lifecycle-manager/v1/goals?$filterKey=$filter"
$meetingsPath = "/lifecycle-manager/v1/meetings?$filterKey=$filter"
$goals = @()
$meetings = @()
try {
  $goals = @(Get-All $goalsPath)
} catch {
  if ($_.Exception.Message -notmatch "422|ClientId does not exist") { throw }
  Write-Warning "Goals rejected the documented client filter; scanning the collection and matching embedded client.id."
  $goals = @(Get-All "/lifecycle-manager/v1/goals" | Where-Object { [string]$_.client.id -eq $lmxClientId })
}
try {
  $meetings = @(Get-All $meetingsPath)
} catch {
  if ($_.Exception.Message -notmatch "422|ClientId does not exist") { throw }
  Write-Warning "Meetings rejected the documented client filter; scanning the collection and matching embedded client.id."
  $meetings = @(Get-All "/lifecycle-manager/v1/meetings" | Where-Object { [string]$_.client.id -eq $lmxClientId })
}
Write-Host "Discovered Goals: $($goals.Count)"
Write-Host "Discovered Meetings: $($meetings.Count)"

if ($SkipCreateDelete) {
  Write-Host "Create/delete verification skipped."
  exit 0
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$testTitle = "LMX cleanup API verification $stamp"
$createdGoalId = $null
$createdMeetingId = $null

try {
  $period = $null
  if ($goals.Count -gt 0) {
    $period = $goals[0].period
  }
  if (-not $period) {
    $year = (Get-Date).Year
    $quarter = [math]::Floor(((Get-Date).Month - 1) / 3) + 1
    $period = @{ type = "PeriodQuarter"; year = $year; quarter = $quarter }
  }

  $goalBody = @{
    client_key = @{ id = $lmxClientId }
    title = $testTitle
    description = "Temporary API verification record. Delete immediately."
    status = "OnTrack"
    target_period = $period
  }
  $createdGoal = Invoke-Lmx -Method POST -Path "/lifecycle-manager/v1/goals" -Body $goalBody
  $createdGoalId = Get-RecordId $createdGoal
  if (-not $createdGoalId) { throw "Goal creation returned no record ID." }
  Write-Host "Created temporary Goal."

  $meetingTypes = @(Get-All "/lifecycle-manager/v1/meeting-types")
  $meetingType = $meetingTypes | Select-Object -First 1
  $meetingTypeId = if ($meetingType.meeting_type_id) { $meetingType.meeting_type_id } else { $meetingType.id }
  if ([string]::IsNullOrWhiteSpace([string]$meetingTypeId)) { throw "No meeting type was available for the temporary Meeting test." }

  $start = (Get-Date).ToUniversalTime().AddMinutes(10)
  $end = $start.AddMinutes(30)
  $agenda = '{"type":"doc","content":[{"type":"paragraph","attrs":{"textAlign":null},"content":[{"type":"text","text":"Temporary API verification record."}]}]}'
  $meetingBody = @{
    client_key = @{ id = $lmxClientId }
    title = $testTitle
    type = [string]$meetingTypeId
    starts_at = $start.ToString("o")
    ends_at = $end.ToString("o")
    agenda_json = $agenda
  }
  $createdMeeting = Invoke-Lmx -Method POST -Path "/lifecycle-manager/v2/meetings" -Body $meetingBody
  $createdMeetingId = Get-RecordId $createdMeeting
  if (-not $createdMeetingId) { throw "Meeting creation returned no record ID." }
  Write-Host "Created temporary Meeting."
} finally {
  if ($createdMeetingId) {
    Invoke-Lmx -Method DELETE -Path "/lifecycle-manager/v1/meetings/$([uri]::EscapeDataString($createdMeetingId))"
    Write-Host "Deleted temporary Meeting."
  }
  if ($createdGoalId) {
    Invoke-Lmx -Method DELETE -Path "/lifecycle-manager/v1/goals/$([uri]::EscapeDataString($createdGoalId))"
    Write-Host "Deleted temporary Goal."
  }
}

$remainingGoals = @(Get-All $goalsPath) | Where-Object { $_.title -eq $testTitle }
$remainingMeetings = @(Get-All $meetingsPath) | Where-Object { $_.title -eq $testTitle }
if ($remainingGoals.Count -gt 0 -or $remainingMeetings.Count -gt 0) {
  throw "Verification records still appeared in the filtered lists after deletion."
}
Write-Host "Verification complete: temporary Goal and Meeting were created and removed successfully."
