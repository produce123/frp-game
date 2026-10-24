# APK 签名密钥生成脚本
# 使用方法：在 Android Studio 的 Terminal 中运行 .\generate-keystore.ps1
# 或在安装了 JDK 的命令行中运行

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  MineMonopoly APK 签名密钥生成工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 keytool 是否可用
$keytool = Get-Command keytool -ErrorAction SilentlyContinue
if (-not $keytool) {
    Write-Host "[错误] 找不到 keytool！请确保已安装 JDK 并配置了 JAVA_HOME 环境变量。" -ForegroundColor Red
    Write-Host ""
    Write-Host "正在自动搜索 keytool..." -ForegroundColor Yellow
    $possiblePaths = @(
        "C:\APP\Android Studio\jbr\bin\keytool.exe",
        "$env:JAVA_HOME\bin\keytool.exe",
        "${env:ProgramFiles}\Android\Android Studio\jbr\bin\keytool.exe",
        "${env:ProgramFiles(x86)}\Android\Android Studio\jbr\bin\keytool.exe",
        "${env:LocalAppData}\Android\Sdk\jbr\bin\keytool.exe",
        "${env:LocalAppData}\Programs\Android Studio\jbr\bin\keytool.exe"
    )
    $foundPath = $null
    foreach ($p in $possiblePaths) {
        if (Test-Path $p) {
            Write-Host "  找到: $p" -ForegroundColor Green
            $foundPath = $p
            break
        }
    }
    if ($foundPath) {
        $env:PATH = "$(Split-Path $foundPath);$env:PATH"
        Write-Host "  已添加到 PATH" -ForegroundColor Green
    } else {
        Write-Host "  未找到 keytool" -ForegroundColor Red
        Write-Host ""
        Write-Host "  或者从 https://adoptium.net 下载安装 JDK 17+" -ForegroundColor Yellow
        pause
        exit 1
    }
}

# 默认值
$defaultAlias = "release"
$defaultValidity = 10000
$keystoreFile = "release.keystore"
$propsFile = "keystore.properties"

Write-Host "即将生成密钥文件: $keystoreFile" -ForegroundColor Yellow
Write-Host ""

# 输入密码
$storePassword = Read-Host "请输入密钥库密码（至少6位，默认: changeit）"
if ([string]::IsNullOrWhiteSpace($storePassword)) {
    $storePassword = "changeit"
}

$keyAlias = Read-Host "请输入密钥别名（默认: $defaultAlias）"
if ([string]::IsNullOrWhiteSpace($keyAlias)) {
    $keyAlias = $defaultAlias
}

$keyPassword = Read-Host "请输入密钥密码（回车与密钥库密码相同）"
if ([string]::IsNullOrWhiteSpace($keyPassword)) {
    $keyPassword = $storePassword
}

$validity = Read-Host "请输入有效期天数（默认: $defaultValidity）"
if ([string]::IsNullOrWhiteSpace($validity)) {
    $validity = $defaultValidity
}

Write-Host ""
Write-Host "请输入证书信息（以下为自签名证书信息）：" -ForegroundColor Yellow

$cn = Read-Host "  姓名 (CN, 默认: FatPaper)"
if ([string]::IsNullOrWhiteSpace($cn)) { $cn = "FatPaper" }
$ou = Read-Host "  组织单位 (OU, 默认: MineMonopoly)"
if ([string]::IsNullOrWhiteSpace($ou)) { $ou = "MineMonopoly" }
$org = Read-Host "  组织 (O, 默认: FatPaper)"
if ([string]::IsNullOrWhiteSpace($org)) { $org = "FatPaper" }
$city = Read-Host "  城市 (L, 默认: Beijing)"
if ([string]::IsNullOrWhiteSpace($city)) { $city = "Beijing" }
$state = Read-Host "  省份 (ST, 默认: Beijing)"
if ([string]::IsNullOrWhiteSpace($state)) { $state = "Beijing" }
$country = Read-Host "  国家代码 (C, 默认: CN)"
if ([string]::IsNullOrWhiteSpace($country)) { $country = "CN" }

$dname = "CN=$cn, OU=$ou, O=$org, L=$city, ST=$state, C=$country"

Write-Host ""
Write-Host "生成参数确认：" -ForegroundColor Cyan
Write-Host "  密钥库文件 : $keystoreFile"
Write-Host "  密钥库密码 : ******"
Write-Host "  密钥别名   : $keyAlias"
Write-Host "  密钥密码   : ******"
Write-Host "  有效期     : $validity 天"
Write-Host "  证书DN     : $dname"
Write-Host ""

$confirm = Read-Host "确认生成? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "已取消。" -ForegroundColor Yellow
    exit 0
}

# 如果已存在，先备份
if (Test-Path $keystoreFile) {
    $backup = "$keystoreFile.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Write-Host "备份现有密钥文件: $backup" -ForegroundColor Yellow
    Move-Item $keystoreFile $backup
}

Write-Host ""
Write-Host "正在生成密钥..." -ForegroundColor Cyan

& keytool -genkeypair `
    -v `
    -keystore $keystoreFile `
    -alias $keyAlias `
    -keyalg RSA `
    -keysize 2048 `
    -validity $validity `
    -storepass $storePassword `
    -keypass $keyPassword `
    -dname $dname

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[错误] 密钥生成失败！请检查 keytool 输出。" -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "[成功] 密钥文件已生成: $keystoreFile" -ForegroundColor Green

# 更新 keystore.properties
$propsContent = @"
# APK 签名密钥配置（请勿提交到版本控制！）
# 由 generate-keystore.ps1 自动生成
storeFile=$keystoreFile
storePassword=$storePassword
keyAlias=$keyAlias
keyPassword=$keyPassword
"@

Set-Content -Path $propsFile -Value $propsContent -Encoding UTF8

Write-Host "[成功] 签名配置已更新: $propsFile" -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  配置完成！现在可以构建 Release APK：" -ForegroundColor Green
Write-Host "  .\gradlew assembleRelease" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚠ 重要提醒：" -ForegroundColor Yellow
Write-Host "  1. keystore.properties 和 release.keystore 已被 .gitignore 排除" -ForegroundColor Yellow
Write-Host "  2. 请妥善保管密钥文件和密码，丢失后将无法更新应用！" -ForegroundColor Yellow
Write-Host "  3. Google Play 上架需要使用不同的签名，请另行生成" -ForegroundColor Yellow

pause
