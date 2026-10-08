#!/bin/sh
# Usage: scripts/set-bundle-id.sh com.example.app "App Store display name" [TEAM_ID]
# Sets the iOS Bundle ID (must match the app record in App Store Connect), the home-screen name and, optionally, the signing team,
# in every place that holds them, then syncs Capacitor.
set -e
BUNDLE="$1"; NAME="$2"; TEAM="$3"
[ -n "$BUNDLE" ] && [ -n "$NAME" ] || { echo "usage: $0 <bundle id> <display name> [team id]"; exit 1; }
cd "$(dirname "$0")/.."
sed -i '' "s|appId: \".*\"|appId: \"$BUNDLE\"|; s|appName: \".*\"|appName: \"$NAME\"|" capacitor.config.ts
sed -i '' "s|PRODUCT_BUNDLE_IDENTIFIER = .*;|PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE;|" ios/App/App.xcodeproj/project.pbxproj
if [ -n "$TEAM" ]; then
  sed -i '' "s|DEVELOPMENT_TEAM = .*;|DEVELOPMENT_TEAM = $TEAM;|" ios/App/App.xcodeproj/project.pbxproj
  grep -q DEVELOPMENT_TEAM ios/App/App.xcodeproj/project.pbxproj || sed -i '' "s|PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE;|PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE;\n\t\t\t\tDEVELOPMENT_TEAM = $TEAM;|" ios/App/App.xcodeproj/project.pbxproj
fi
npx cap sync ios
echo "Bundle ID: $BUNDLE | name: $NAME | team: ${TEAM:-<unchanged>}"
