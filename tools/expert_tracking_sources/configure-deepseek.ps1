$ErrorActionPreference = "Stop"
$secureKey = Read-Host "请输入公司 DeepSeek API Key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if (-not $plainKey.StartsWith("sk-") -or $plainKey.Length -lt 20) {
    throw "密钥格式不正确。"
  }
  [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $plainKey, "User")
  Write-Host "DeepSeek 密钥已保存到当前 Windows 用户环境变量；未写入项目文件。"
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $plainKey = $null
}
