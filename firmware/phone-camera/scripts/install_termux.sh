#!/data/data/com.termux/files/usr/bin/bash
# One-time setup of the phone camera node inside Termux.
set -eu
cd "$(dirname "$0")/.."

pkg update -y
pkg install -y python termux-api ffmpeg openssl ca-certificates
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

mkdir -p spool captures logs
chmod +x camera_agent.py scripts/*.sh
[ -f config.json ] || { cp config.example.json config.json; chmod 600 config.json; echo "Created config.json"; }

echo
echo "Next steps:"
echo "  1. Install the Termux:API app (same source as Termux) and grant it Camera permission."
echo "  2. Edit config.json: camera_id, upload.url, upload.token  (nano config.json)"
echo "  3. python camera_agent.py --check-camera    # test the camera"
echo "  4. python camera_agent.py --check-upload    # test HTTPS upload"
echo "  5. ./scripts/run_camera.sh                  # run the node"
