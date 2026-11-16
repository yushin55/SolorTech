"""Download the private raw-data repository during the server build.

Raw K-water records and KMA files are kept out of the public code repository.
The Docker build reads a read-only GitHub token from a Render secret file and
downloads the data repository as a tarball, then import_data.py processes it.

Usage (inside the Docker build):
    python scripts/fetch_data.py <owner/repo> <token-file> <destination>
"""

import io
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath


def extract(tar_bytes, destination):
    """Unpack a GitHub tarball, dropping its top-level ``owner-repo-sha/`` folder."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    count = 0
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as archive:
        for member in archive.getmembers():
            parts = PurePosixPath(member.name).parts[1:]
            if not parts or not (member.isfile() or member.isdir()):
                continue
            target = (destination / Path(*parts)).resolve()
            if root not in target.parents and target != root:
                raise ValueError(f"압축 경로가 대상 폴더 밖을 가리킵니다: {member.name}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
            count += 1
    return count


def download(repository, token):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/tarball",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "User-Agent": "solartech-build"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        hint = {401: "토큰이 잘못되었거나 만료되었습니다.",
                404: "레포 이름이 틀렸거나 토큰에 이 레포 읽기 권한이 없습니다."}.get(exc.code, "")
        raise SystemExit(f"데이터 레포 다운로드 실패 (HTTP {exc.code}) {hint}") from exc


def main(argv):
    if len(argv) != 4:
        raise SystemExit(__doc__)
    repository, token_file, destination = argv[1:]
    if not repository or "/" not in repository:
        raise SystemExit("DATA_REPO 환경변수에 '소유자/레포' 형식으로 데이터 레포를 지정하세요.")
    token = Path(token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("data_token 시크릿 파일이 비어 있습니다.")
    count = extract(download(repository, token), destination)
    print(f"데이터 레포 {repository}: 파일 {count}개 → {destination}")


if __name__ == "__main__":
    main(sys.argv)
