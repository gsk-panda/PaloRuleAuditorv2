$panoramaUrl = "https://10.1.0.100"
$apiKey = "LUFRPT1Rd0kzTmtpWUpGWENCOGpBMUJQRE4xV2NVNEE9bkhyQlliV2hlVHpGcjdHbWZTdVdweTVIK0IrbldBUjFGbEJKMFI5TUd5Q3E1VkVrakJmK3p1bkcwN2dobjM4cHFQSzJYTnA5RmRZek8xcit0bzNRL2c9PQ=="
$deviceGroup = "ISS"

# Configure TLS and certificate validation settings
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

# Create a WebClient object for direct download
$webClient = New-Object System.Net.WebClient

# Function to URL encode a string without using System.Web.HttpUtility
function UrlEncode($string) {
    $encoded = [System.Uri]::EscapeDataString($string)
    return $encoded
}

# Function to convert XML to PowerShell objects
function Convert-XmlToPsObject {
    param(
        [Parameter(Mandatory=$true)]
        [string]$XmlString
    )
    
    try {
        $xml = [xml]$XmlString
        return $xml
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "Error parsing XML: $errMsg"
        return $null
    }
}

# Function to get device hostname map
function Get-DeviceHostnameMap {
    Write-Host "Getting device hostname map..."
    $cmd = "<show><devices><all/></devices></show>"
    $url = "$panoramaUrl/api/?type=op&cmd=$(UrlEncode($cmd))&key=$apiKey"
    
    try {
        $response = $webClient.DownloadString($url)
        $xmlData = Convert-XmlToPsObject -XmlString $response
        
        if ($null -eq $xmlData) {
            Write-Host "Failed to parse devices XML"
            return @{}
        }
        
        $hostnameMap = @{}
        
        if ($xmlData.response.result.devices.entry) {
            $entries = $xmlData.response.result.devices.entry
            
            # Handle single entry vs array
            if ($entries -is [System.Xml.XmlElement]) {
                $serial = $entries.serial
                $hostname = $entries.hostname
                if ($serial -and $hostname) {
                    $hostnameMap[$serial] = $hostname
                    # Also store with zero-padded serial (to 12 digits)
                    $hostnameMap[$serial.PadLeft(12, '0')] = $hostname
                }
            } else {
                foreach ($entry in $entries) {
                    $serial = $entry.serial
                    $hostname = $entry.hostname
                    if ($serial -and $hostname) {
                        $hostnameMap[$serial] = $hostname
                        # Also store with zero-padded serial (to 12 digits)
                        $hostnameMap[$serial.PadLeft(12, '0')] = $hostname
                    }
                }
            }
            
            Write-Host "Found $($hostnameMap.Count) device hostname mappings"
        } else {
            Write-Host "No devices found"
        }
        
        return $hostnameMap
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "Error getting device hostname map: $errMsg"
        return @{}
    }
}

# Function to get device groups
function Get-DeviceGroups {
    Write-Host "Getting device groups..."
    $cmd = "<show><devicegroups></devicegroups></show>"
    $url = "$panoramaUrl/api/?type=op&cmd=$(UrlEncode($cmd))&key=$apiKey"
    
    try {
        $response = $webClient.DownloadString($url)
        Write-Host "Response received for device groups"
        $xmlData = Convert-XmlToPsObject -XmlString $response
        
        if ($null -eq $xmlData) {
            Write-Host "Failed to parse device groups XML"
            return @()
        }
        
        $deviceGroups = @()
        
        if ($xmlData.response.result.devicegroups.entry) {
            $entries = $xmlData.response.result.devicegroups.entry
            
            # Handle single entry vs array
            if ($entries -is [System.Xml.XmlElement]) {
                $deviceGroups += $entries.name
            } else {
                foreach ($entry in $entries) {
                    $deviceGroups += $entry.name
                }
            }
            
            Write-Host "Found $($deviceGroups.Count) device groups"
        } else {
            Write-Host "No device groups found"
        }
        
        return $deviceGroups
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "Error getting device groups: $errMsg"
        return @()
    }
}

# Function to get security rules using a direct config API call
function Get-SecurityRules {
    param(
        [string]$DeviceGroup
    )
    
    Write-Host "Getting security rules for device group: $DeviceGroup"
    
    # Use a direct config API call to get the rules
    $url = "$panoramaUrl/api/?type=config&action=get&xpath=/config/devices/entry[@name='localhost.localdomain']/device-group/entry[@name='$DeviceGroup']/pre-rulebase/security/rules&key=$apiKey"
    Write-Host "API URL: $panoramaUrl/api/?type=config&action=get&xpath=[encoded]&key=[hidden]"
    
    try {
        Write-Host "Sending request for security rules..."
        $response = $webClient.DownloadString($url)
        Write-Host "Response received for security rules"
        
        # Save the response to a file for inspection
        $response | Out-File -FilePath "security-rules-response.xml" -Encoding utf8
        Write-Host "Saved response to security-rules-response.xml"
        
        $xmlData = Convert-XmlToPsObject -XmlString $response
        
        if ($null -eq $xmlData) {
            Write-Host "Failed to parse security rules XML"
            return @()
        }
        
        # The XML structure might be complex, so let's save it to a file for inspection
        $xmlData.OuterXml | Out-File -FilePath "security-rules-xml.xml" -Encoding utf8
        Write-Host "Saved parsed XML to security-rules-xml.xml"
        
        # Debug output to help identify the correct XML path
        Write-Host "XML structure:"
        Write-Host "Has response: $($null -ne $xmlData.response)"
        Write-Host "Has result: $($null -ne $xmlData.response.result)"
        Write-Host "Has rules: $($null -ne $xmlData.response.result.rules)"
        
        # Process rules and extract relevant information
        $rules = @()
        
        # Try different XML paths to find the rules
        $entries = $null
        
        if ($xmlData.response.result.rules.entry) {
            $entries = $xmlData.response.result.rules.entry
            Write-Host "Found rules via response.result.rules.entry"
        }
        
        if ($entries) {
            # Handle single entry vs array
            if ($entries -is [System.Xml.XmlElement]) {
                $entries = @($entries)
            }
            
            Write-Host "Found $($entries.Count) rules"
            
            foreach ($entry in $entries) {
                $ruleName = $entry.name
                Write-Host "Processing rule: $ruleName"
                
                $ruleInfo = [PSCustomObject]@{
                    Name = $ruleName
                    Description = $entry.description
                    Source = ($entry.source.member -join ", ")
                    Destination = ($entry.destination.member -join ", ")
                    Service = ($entry.service.member -join ", ")
                    Action = $entry.action
                    TargetsAll = $false
                    SpecificTargets = @()
                }
                
                # Process target information
                if ($entry.target) {
                    # Debug output for target structure
                    Write-Host "  Target element structure:"
                    Write-Host "    Has negate: $($null -ne $entry.target.negate)"
                    Write-Host "    Negate value: $($entry.target.negate)"
                    Write-Host "    Has devices: $($null -ne $entry.target.devices)"
                    Write-Host "    Has device-vsys: $($null -ne $entry.target.'device-vsys')"
                    
                    # Check if the rule targets all devices in the group
                    if ($entry.target.negate -and $entry.target.negate -eq "no") {
                        $ruleInfo.TargetsAll = $true
                        Write-Host "  Rule targets all devices in the group"
                    }
                    
                    # Check for specific device targets
                    if ($entry.target.devices -and $entry.target.devices.entry) {
                        $deviceEntries = $entry.target.devices.entry
                        
                        # Handle single entry vs array
                        if ($deviceEntries -is [System.Xml.XmlElement]) {
                            $deviceEntries = @($deviceEntries)
                        }
                        
                        Write-Host "  Found $($deviceEntries.Count) device targets"
                        
                        foreach ($device in $deviceEntries) {
                            $deviceName = $device.name
                            $hostname = $hostnameMap[$deviceName]
                            
                            $targetInfo = [PSCustomObject]@{
                                Serial = $deviceName
                                Hostname = $hostname
                            }
                            
                            $ruleInfo.SpecificTargets += $targetInfo
                            Write-Host "  Target: $deviceName ($hostname)"
                        }
                    }
                    
                    # Check for device-vsys targets
                    if ($entry.target.'device-vsys' -and $entry.target.'device-vsys'.entry) {
                        $deviceVsysEntries = $entry.target.'device-vsys'.entry
                        
                        # Handle single entry vs array
                        if ($deviceVsysEntries -is [System.Xml.XmlElement]) {
                            $deviceVsysEntries = @($deviceVsysEntries)
                        }
                        
                        Write-Host "  Found $($deviceVsysEntries.Count) device-vsys targets"
                        
                        foreach ($deviceVsys in $deviceVsysEntries) {
                            $deviceVsysName = $deviceVsys.name
                            
                            # Extract device serial from device-vsys entry
                            Write-Host "    Processing device-vsys entry: $deviceVsysName"
                            
                            if ($deviceVsysName -match '^([^/]+)/') {
                                $deviceSerial = $matches[1]
                                $hostname = $hostnameMap[$deviceSerial]
                                
                                if ($null -eq $hostname) {
                                    Write-Host "    WARNING: No hostname found for serial $deviceSerial"
                                    # Try with zero-padded serial
                                    $paddedSerial = $deviceSerial.PadLeft(12, '0')
                                    $hostname = $hostnameMap[$paddedSerial]
                                    if ($null -eq $hostname) {
                                        Write-Host "    WARNING: No hostname found for padded serial $paddedSerial either"
                                    } else {
                                        Write-Host "    Found hostname using padded serial: $hostname"
                                    }
                                }
                                
                                $targetInfo = [PSCustomObject]@{
                                    Serial = $deviceSerial
                                    Hostname = $hostname
                                    VsysName = $deviceVsysName
                                }
                                
                                $ruleInfo.SpecificTargets += $targetInfo
                                Write-Host "  Target (vsys): $deviceVsysName ($hostname)"
                            } else {
                                Write-Host "    WARNING: Could not extract serial from device-vsys entry: $deviceVsysName"
                            }
                        }
                    }
                    
                    # Debug output for target counts
                    Write-Host "  Total targets found: $($ruleInfo.SpecificTargets.Count)"
                } else {
                    # If no target element, rule applies to all devices in the group
                    $ruleInfo.TargetsAll = $true
                    Write-Host "  No target element - rule applies to all devices in the group"
                }
                
                $rules += $ruleInfo
            }
        } else {
            Write-Host "No rules found in the XML response"
        }
        
        Write-Host "Successfully processed $($rules.Count) rules"
        return $rules
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "Error getting security rules: $errMsg"
        return @()
    }
}

# Main execution
try {
    # Get device hostname map
    $hostnameMap = Get-DeviceHostnameMap
    
    # Check if the device group exists
    $deviceGroups = Get-DeviceGroups
    if ($deviceGroups -notcontains $deviceGroup) {
        Write-Host "Device group '$deviceGroup' not found. Available device groups:"
        foreach ($dg in $deviceGroups) {
            Write-Host "  - $dg"
        }
        exit
    }
    
    # Get security rules
    $rules = Get-SecurityRules -DeviceGroup $deviceGroup
    
    # Display rule information in a formatted table
    Write-Host "`n=== Security Rules for Device Group: $deviceGroup ==="

    foreach ($rule in $rules) {
        Write-Host "Rule: $($rule.Name)"
        Write-Host "  Description: $($rule.Description)"
        Write-Host "  Source: $($rule.Source)"
        Write-Host "  Destination: $($rule.Destination)"
        Write-Host "  Service: $($rule.Service)"
        Write-Host "  Action: $($rule.Action)"
        
        if ($rule.TargetsAll) {
            Write-Host "  Targets: All devices in device group"
        } else {
            Write-Host "  Targets:"
            
            if ($rule.SpecificTargets.Count -gt 0) {
                Write-Host "  ----------------------------------------"
                Write-Host "  | Serial Number      | Hostname        |"
                Write-Host "  ----------------------------------------"
                
                foreach ($target in $rule.SpecificTargets) {
                    $serialPadded = $target.Serial.PadRight(18)
                    $hostnamePadded = (if ($null -eq $target.Hostname) { "N/A" } else { $target.Hostname }).PadRight(15)
                    Write-Host "  | $serialPadded | $hostnamePadded |"
                }
                
                Write-Host "  ----------------------------------------"
            } else {
                Write-Host "  No specific targets found"
            }
        }
        
        Write-Host ""
    }
    
    # Save results to CSV
    $csvData = @()
    
    foreach ($rule in $rules) {
        if ($rule.SpecificTargets.Count -gt 0) {
            foreach ($target in $rule.SpecificTargets) {
                $csvData += [PSCustomObject]@{
                    RuleName = $rule.Name
                    Description = $rule.Description
                    Source = $rule.Source
                    Destination = $rule.Destination
                    Service = $rule.Service
                    Action = $rule.Action
                    TargetsAll = $rule.TargetsAll
                    TargetSerial = $target.Serial
                    TargetHostname = $target.Hostname
                    HasVsys = if ($target.VsysName) { $true } else { $false }
                    VsysName = $target.VsysName
                }
            }
        } else {
            $csvData += [PSCustomObject]@{
                RuleName = $rule.Name
                Description = $rule.Description
                Source = $rule.Source
                Destination = $rule.Destination
                Service = $rule.Service
                Action = $rule.Action
                TargetsAll = $rule.TargetsAll
                TargetSerial = if ($rule.TargetsAll) { "All devices in group" } else { "None" }
                TargetHostname = if ($rule.TargetsAll) { "All devices in group" } else { "None" }
                HasVsys = $false
                VsysName = $null
            }
        }
    }
    
    $csvData | Export-Csv -Path "$deviceGroup-rules-and-targets.csv" -NoTypeInformation
    Write-Host "Results saved to $deviceGroup-rules-and-targets.csv"
    
    Write-Host "Script completed successfully"
} catch {
    $errMsg = $_.Exception.Message
    Write-Host "Error in main execution: $errMsg"
}
