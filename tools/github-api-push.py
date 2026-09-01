"""GitHub Git Data API 复刻链推送(github.com:443 被阻断时的绕行).

2026-09-01 实证:本机 github.com:443 间歇性被重置,api.github.com 稳定可达。
原理:逐提交 POST blobs→trees→commits(message 去尾换行,与 GitHub 对齐),
本地同步用 hash-object 重建同字节复制对象,parent 映射成复制链,最后 PATCH refs。
结束后:git update-ref refs/heads/main <新头> && git update-ref refs/remotes/origin/main <新头>

用法: py -3 tools/github-api-push.py <起始sha(不含)> <末端sha>
需要环境变量 GITHUB_TOKEN(repo 权限 PAT)。
"""
import datetime, json, os, subprocess, sys, urllib.request

TOKEN = os.environ["GITHUB_TOKEN"]
API = "https://api.github.com/repos/guqingchong/-AutoViral/git"
START, END = sys.argv[1], sys.argv[2]

def req(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
        "Content-Type": "application/json", "User-Agent": "git-api-push"})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.load(resp)

def git(*args, inp=None):
    p = subprocess.run(["git", "-c", "core.quotepath=false", *args], input=inp, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {p.stderr.decode(errors='replace')[:300]}")
    return p.stdout

def iso_from_sig(ts: str, tz: str) -> str:
    sign = 1 if tz[0] == "+" else -1
    offset = datetime.timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])) * sign
    return datetime.datetime.fromtimestamp(int(ts), datetime.timezone(offset)).isoformat()

commits = git("rev-list", "--reverse", f"{START}..{END}").decode().split()
print(f"{len(commits)} commits to push")
parent_map = {}

for sha in commits:
    raw = git("cat-file", "commit", sha)
    header, msg = raw.split(b"\n\n", 1)
    msg = msg.rstrip(b"\n")  # GitHub 裁剪尾换行,以此为准
    lines = header.decode().splitlines()
    tree = lines[0].split()[1]
    parent_orig = next((l.split()[1] for l in lines if l.startswith("parent ")), None)
    parent = parent_map.get(parent_orig, parent_orig)

    def parse_sig(prefix):
        l = next(l for l in lines if l.startswith(prefix))
        meta, ts, tz = l[len(prefix) + 1:].rsplit(" ", 2)
        name, email = meta.rsplit(" <", 1)
        return {"name": name, "email": email.rstrip(">"), "date": iso_from_sig(ts, tz)}, l[len(prefix) + 1:]

    author, author_raw = parse_sig("author")
    committer, committer_raw = parse_sig("committer")

    files = git("diff-tree", "--no-commit-id", "--name-status", "-r", sha).decode().splitlines()
    tree_items = []
    for line in files:
        status, path = line.split("\t")[:2]
        if status.startswith("D"):
            tree_items.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        blob_sha = git("rev-parse", f"{sha}:{path}").decode().strip()
        content = git("show", f"{sha}:{path}")
        blob = req("POST", f"{API}/blobs", {"content": content.decode("utf-8"), "encoding": "utf-8"})
        assert blob["sha"] == blob_sha, f"blob mismatch {path}"
        tree_items.append({"path": path, "mode": "100644", "type": "blob", "sha": blob_sha})

    remote_tree = req("POST", f"{API}/trees", {"base_tree": parent, "tree": tree_items})
    assert remote_tree["sha"] == tree, f"tree mismatch {sha}"

    replica = (f"tree {tree}\n" + (f"parent {parent}\n" if parent else "")
               + f"author {author_raw}\ncommitter {committer_raw}\n\n").encode() + msg
    local_replica = git("hash-object", "-t", "commit", "-w", "--stdin", inp=replica).decode().strip()

    commit = req("POST", f"{API}/commits", {
        "message": msg.decode("utf-8"), "tree": tree,
        "parents": [parent] if parent else [],
        "author": author, "committer": committer,
    })
    assert commit["sha"] == local_replica, f"replica mismatch: remote {commit['sha']} != local {local_replica}"
    parent_map[sha] = local_replica
    print("replicated:", sha[:7], "->", local_replica[:7])

head = parent_map[commits[-1]]
req("PATCH", f"{API}/refs/heads/main", {"sha": head, "force": False})
print("REF_UPDATED main ->", head)
print("对齐本地: git update-ref refs/heads/main", head, "&& git update-ref refs/remotes/origin/main", head)
