# 见行修学 · 安卓 App

这是可安装的安卓应用（Capacitor），打开后进入学习中心：https://jianxing.win/app/  
账号与学习进度和网页共用。

## 方式一：用 GitHub Actions 下载 APK（推荐）

1. 把本仓库推送到 GitHub
2. 打开仓库 **Actions** → **Build Android APK** → **Run workflow**
3. 跑完后在该次运行页下载产物 `jianxing-android-debug`（内含 `app-debug.apk`）
4. 传到安卓手机，允许「安装未知应用」后安装

## 方式二：本机 Android Studio 打包

需要先安装：JDK 17+、Android Studio、Android SDK。

```bash
npm install
npm run android:sync
npm run android:open
```

在 Android Studio 中：Build → Build Bundle(s) / APK(s) → Build APK(s)。

## 说明

- 应用包名：`win.jianxing.app`
- 需联网使用（内容与账号在服务器上）
- 当前为调试版 APK，适合先试用；上架应用商店需另签正式包
