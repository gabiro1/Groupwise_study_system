$file = 'd:\PROGRAMMING\Nextjs\PROJECTs\TWIGANE\frontend\src\app\dashboard\DashboardWorkspace.js'
$c = [System.IO.File]::ReadAllText($file)

$exportIdx = $c.IndexOf('export default function DashboardWorkspace')

# Find the first } that closes DashboardSection
# It's the } on line 598 - after the courses fallback return
# The courses fallback ends with:  </section>\n  );\n}
# Then there's a blank line, then "  const matchingGroups" (the duplicate)
# We want to find the } that is followed by whitespace then "  const matchingGroups"

# Search for the pattern: }\n\n\n  const matchingGroups (with CRLF or LF)
$searchStr = "}" + "`r`n" + "`r`n" + "`r`n" + "  const matchingGroups"
$idx = $c.IndexOf($searchStr)
if ($idx -lt 0) {
    $searchStr = "}" + "`n" + "`n" + "  const matchingGroups"
    $idx = $c.IndexOf($searchStr)
}
if ($idx -lt 0) {
    # Try with just one blank line
    $searchStr = "}" + "`r`n" + "`r`n" + "  const matchingGroups"
    $idx = $c.IndexOf($searchStr)
}
Write-Output "Found at: $idx"
if ($idx -ge 0) {
    $c.Substring($idx, 80)
}
