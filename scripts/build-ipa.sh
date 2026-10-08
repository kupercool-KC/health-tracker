#!/bin/sh
# Usage: scripts/build-ipa.sh TEAM_ID
# Builds a signed App Store .ipa (build/export/*.ipa) from the iOS project. Needs Xcode and the team's signing set up
# (Xcode → Settings → Accounts, signed in with an Apple ID that is on the team). Automatic signing creates the certificates.
set -e
TEAM="$1"; [ -n "$TEAM" ] || { echo "usage: $0 <team id>"; exit 1; }
cd "$(dirname "$0")/.."
npm install
npx cap sync ios
mkdir -p build
cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/App.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" archive
xcodebuild -exportArchive -archivePath build/App.xcarchive -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
ls -la build/export/*.ipa
echo "Upload: open the Transporter app and drag the .ipa in, or: xcrun altool --upload-app -f build/export/*.ipa -t ios --apiKey KEY --apiIssuer ISSUER"
