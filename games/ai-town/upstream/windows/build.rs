//! 程序里的 Windows 资源：清单（app.manifest）、版本信息，打包时再加上图标。用 mingw 的 windres
//! 编成目标文件链进去。图标由 scripts/windows/build.mjs 画好，经 AI_TOWN_WINDOWS_ICON 传进来。
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=AI_TOWN_WINDOWS_ICON");
    println!("cargo:rerun-if-env-changed=AI_TOWN_VERSION");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let version = env::var("AI_TOWN_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into());
    let mut numbers: Vec<u16> = version
        .split(['.', '-', '+'])
        .filter_map(|part| part.parse().ok())
        .take(4)
        .collect();
    numbers.resize(4, 0);
    let numbers = numbers
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // windres 认 / 分隔的路径；资源文件按 UTF-8 读，中文写进版本信息
    let path = |p: PathBuf| p.display().to_string().replace('\\', "/");
    let mut rc = String::from("#pragma code_page(65001)\n");
    if let Ok(icon) = env::var("AI_TOWN_WINDOWS_ICON") {
        println!("cargo:rerun-if-changed={icon}");
        rc += &format!("1 ICON \"{}\"\n", path(icon.into()));
    }
    rc += &format!("1 24 \"{}\"\n", path(here.join("app.manifest")));
    rc += &format!(
        r#"1 VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "080404B0"
    BEGIN
      VALUE "FileDescription", "AI小镇"
      VALUE "ProductName", "AI小镇"
      VALUE "FileVersion", "{version}"
      VALUE "ProductVersion", "{version}"
      VALUE "OriginalFilename", "AI小镇.exe"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0804, 1200
  END
END
"#
    );
    fs::write(out.join("app.rc"), rc).unwrap();
    let windres = env::var("WINDRES").unwrap_or_else(|_| "x86_64-w64-mingw32-windres".into());
    let object = out.join("app-resources.o");
    let status = Command::new(&windres)
        .args(["-c", "65001", "-O", "coff", "-i"])
        .arg(out.join("app.rc"))
        .arg("-o")
        .arg(&object)
        .status()
        .unwrap_or_else(|e| panic!("运行 {windres} 失败（要先 brew install mingw-w64）：{e}"));
    assert!(status.success(), "{windres} 没能编译资源");
    println!("cargo:rustc-link-arg-bins={}", object.display());
}
