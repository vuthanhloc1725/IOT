#!/data/data/com.termux/files/usr/bin/bash
# Đổi địa chỉ server + token trong config.json, không cần sửa tay.
#
#   bash scripts/set_server.sh                       # hỏi lần lượt: URL → token → mã camera
#   bash scripts/set_server.sh http://192.168.1.10:3000 <token> [CAM-001]
#
# URL nhập dạng nào cũng được: 192.168.1.10:3000, http://192.168.1.10:3000,
# hay dán nguyên .../api/camera/media — script tự suy ra url (upload) và heartbeat_url.
# Nhấn Enter ở một câu hỏi = giữ giá trị hiện tại.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${CONFIG:-config.json}"
if [ ! -f "$CONFIG" ]; then
  [ -f config.example.json ] || { echo "Không thấy $CONFIG lẫn config.example.json" >&2; exit 1; }
  cp config.example.json "$CONFIG"
  echo "Chưa có $CONFIG → đã tạo từ config.example.json"
fi

current() { # current <python-expr trên biến c>
  python - "$CONFIG" "$1" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8"))
try:
    print(eval(sys.argv[2]) or "")
except Exception:
    print("")
EOF
}

CUR_URL="$(current 'c["upload"]["url"]')"
CUR_TOKEN="$(current 'c["upload"]["token"]')"
CUR_CAM="$(current 'c["camera_id"]')"

URL="${1:-}"
TOKEN="${2:-}"
CAM="${3:-}"

if [ -z "$URL" ]; then
  echo "URL server hiện tại: ${CUR_URL:-<chưa có>}"
  read -r -p "Nhập URL server (vd http://192.168.1.10:3000, Enter = giữ nguyên): " URL
fi
if [ -z "$TOKEN" ]; then
  if [ -n "$CUR_TOKEN" ] && [[ "$CUR_TOKEN" != *REPLACE* ]]; then
    echo "Token hiện tại: …${CUR_TOKEN: -4}"
  else
    echo "Token hiện tại: <chưa có>"
  fi
  read -r -p "Dán token camera (Enter = giữ nguyên): " TOKEN
fi
if [ $# -lt 3 ]; then
  read -r -p "Mã camera [${CUR_CAM:-CAM-001}] (Enter = giữ nguyên): " CAM
fi

cp "$CONFIG" "$CONFIG.bak"

python - "$CONFIG" "$URL" "$TOKEN" "$CAM" <<'EOF'
import json, re, sys, urllib.parse

path, url, token, cam = (a.strip() for a in sys.argv[1:5])
cfg = json.load(open(path, encoding="utf-8"))
up = cfg.setdefault("upload", {})

if url:
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    p = urllib.parse.urlparse(url)
    if not p.hostname:
        sys.exit(f"URL không hợp lệ: {url}")
    if p.hostname in ("localhost", "127.0.0.1"):
        print("CẢNH BÁO: localhost trên điện thoại là chính điện thoại — hãy dùng IP LAN của máy chạy Backend.")
    # Bỏ mọi đường dẫn phía sau (…/api/camera/media, /api, dấu / thừa) → chỉ giữ scheme://host:port
    base = f"{p.scheme.lower()}://{p.netloc}"
    up["url"] = f"{base}/api/camera/media"
    up["heartbeat_url"] = f"{base}/api/camera/heartbeat"
    up["allow_insecure_http"] = p.scheme.lower() == "http"
    print(f"url           = {up['url']}")
    print(f"heartbeat_url = {up['heartbeat_url']}")
    if up["allow_insecure_http"]:
        print("allow_insecure_http = true (http:// trong mạng LAN)")

if token:
    token = token.strip().strip('"').strip("'")
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if re.search(r"\s", token):
        sys.exit("Token có khoảng trắng/xuống dòng — dán lại đúng một dòng token.")
    up["token"] = token
    print(f"token         = …{token[-4:]} ({len(token)} ký tự)")

if cam:
    cfg["camera_id"] = cam
    print(f"camera_id     = {cam}")

if not (url or token or cam):
    print("Không có gì thay đổi.")

json.dump(cfg, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(path, "a").write("\n")
EOF

chmod 600 "$CONFIG" "$CONFIG.bak" 2>/dev/null || true
echo "Đã lưu $CONFIG (bản cũ: $CONFIG.bak)."

if python camera_agent.py --config "$CONFIG" --check-heartbeat; then
  echo "OK: server nhận heartbeat. Khởi động lại agent để dùng cấu hình mới (Ctrl+C rồi ./scripts/run_camera.sh)."
else
  echo "Heartbeat lỗi — kiểm tra URL/IP, cổng 3000, tường lửa và token (cấp lại token trên web nếu cần)." >&2
  exit 1
fi
