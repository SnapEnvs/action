"""Publish one application layer using a cached Linux/amd64 runtime and crane.

The runtime target must depend only on the declared runtime-key-files and pinned
base images. Every release starts from its digest, never the last app image.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import time


def lines(value):
    return [line.strip() for line in value.splitlines() if line.strip()]


def relative_name(value):
    parts = value.split("/")
    if (not value or value.startswith("/") or "\\" in value
            or any(part in ("", ".", "..") for part in parts)):
        raise ValueError("File inputs must be explicit relative paths without traversal or globs.")
    if any(character in value for character in "*?[]\n\r\0"):
        raise ValueError("File inputs must not contain globs or control characters.")
    return PurePosixPath(value)


def checked_path(source, name):
    relative = relative_name(name)
    path = source
    for part in relative.parts:
        if part == ".git" or part == ".env" or part.startswith(".env."):
            raise ValueError("Git metadata and environment files must not enter image layers.")
        path = path / part
        if path.is_symlink():
            raise ValueError("Image inputs must not contain symlinks.")
    if not path.resolve(strict=True).is_relative_to(source.resolve()):
        raise ValueError("Image inputs must stay inside the source directory.")
    return path


def runtime_key(source, names):
    if not names or "Dockerfile" not in names or len(names) != len(set(names)):
        raise ValueError("Runtime inputs must include Dockerfile exactly once and have no duplicates.")
    checksum = hashlib.sha256()
    for name in names:
        checksum.update(name.encode() + b"\0" + checked_path(source, name).read_bytes() + b"\0")
    return checksum.hexdigest()


def pack(source, target, names, destination="/app", uid=10001, gid=10001):
    if not destination.startswith("/"):
        raise ValueError("The image destination must be absolute.")
    prefix = str(relative_name(destination[1:]))
    if not names:
        raise ValueError("Select at least one application file or directory.")
    if not all(isinstance(owner, int) and 0 <= owner <= 2147483647 for owner in (uid, gid)):
        raise ValueError("File ownership must use nonnegative numeric IDs.")
    paths = set()

    def collect(path):
        checked_path(source, path.relative_to(source).as_posix())
        if path.name == "__pycache__" or path.suffix == ".pyc":
            return
        if path.is_dir():
            for child in path.iterdir():
                collect(child)
        elif path.is_file():
            paths.add(path)
        else:
            raise ValueError("Image inputs must be regular files or directories.")

    for name in names:
        collect(checked_path(source, name))
    if not paths:
        raise ValueError("The selected application layer is empty.")
    with tarfile.open(target, "w") as archive:
        for path in sorted(paths):
            value = path.read_bytes()
            entry = tarfile.TarInfo(prefix + "/" + path.relative_to(source).as_posix())
            entry.uid, entry.gid = uid, gid
            entry.mode = 0o644
            entry.mtime = 0
            entry.size = len(value)
            archive.addfile(entry, io.BytesIO(value))


def run(*args, **kwargs):
    return subprocess.run(args, text=True, check=True, **kwargs)


def publish(source, image, sha, repository, files, runtime_files,
            destination="/app", uid=10001, gid=10001, environment=()):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Use the exact GitHub commit.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Use a GitHub owner/repository identity.")
    if not re.fullmatch(r"[a-z0-9.-]+(?::[0-9]{1,5})?/[a-z0-9._-]+(?:/[a-z0-9._-]+)*", image):
        raise ValueError("Use a registry image repository without tag or digest.")
    for value in environment:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=[^\r\n\0]*", value):
            raise ValueError("Image environment entries must use KEY=value on one line.")
    started = time.perf_counter()
    source = source.resolve(strict=True)
    runtime = image + ":runtime-" + runtime_key(source, runtime_files)
    with tempfile.TemporaryDirectory(prefix="snapenvs-layer-") as directory:
        layer = Path(directory) / "app.tar"
        pack(source, layer, files, destination, uid, gid)
        lookup = subprocess.run(["crane", "digest", runtime], text=True, capture_output=True)
        rebuilt = False
        if lookup.returncode:
            if "MANIFEST_UNKNOWN" not in lookup.stderr and "NAME_UNKNOWN" not in lookup.stderr:
                raise RuntimeError("Cannot read the runtime image. Check registry access.")
            rebuilt = True
            print("Runtime cache miss: building dependencies once.", flush=True)
            run("docker", "build", "--platform", "linux/amd64", "--target", "runtime",
                "--tag", runtime, str(source))
            run("docker", "push", runtime)
            lookup = run("crane", "digest", runtime, capture_output=True)
        runtime_digest = lookup.stdout.strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", runtime_digest):
            raise RuntimeError("Invalid runtime digest.")
        runtime_seconds = time.perf_counter() - started
        packaged = time.perf_counter()
        env_args = [arg for value in environment for arg in ("--env", value)]
        result = run("crane", "mutate", image + "@" + runtime_digest,
                     "--platform", "linux/amd64", "--append", str(layer), *env_args,
                     "--label", "org.opencontainers.image.revision=" + sha,
                     "--label", "org.opencontainers.image.source=https://github.com/" + repository,
                     "--tag", image + ":" + sha, capture_output=True)
        output_lines = result.stdout.strip().splitlines()
        reference = output_lines[-1] if output_lines else ""
        if not re.fullmatch(re.escape(image) + r"@sha256:[a-f0-9]{64}", reference):
            raise RuntimeError("The published image did not return an immutable digest.")
        metrics = {"runtimeCacheMiss": rebuilt, "runtimeDigest": runtime_digest,
                   "runtimeSeconds": round(runtime_seconds, 3), "layerBytes": layer.stat().st_size,
                   "pushSeconds": round(time.perf_counter() - packaged, 3),
                   "seconds": round(time.perf_counter() - started, 3),
                   "image": reference, "digest": reference.split("@")[1]}
    print(json.dumps(metrics), flush=True)
    return metrics


def main():
    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
    source = (workspace / os.environ["PUBLISH_CONTEXT"]).resolve(strict=True)
    if not source.is_relative_to(workspace) or not source.is_dir():
        raise ValueError("The context must be a directory inside the GitHub workspace.")
    metrics = publish(
        source, os.environ["PUBLISH_IMAGE"], os.environ["GITHUB_SHA"], os.environ["GITHUB_REPOSITORY"],
        lines(os.environ["PUBLISH_FILES"]), lines(os.environ["PUBLISH_RUNTIME_KEY_FILES"]),
        os.environ["PUBLISH_DESTINATION"], int(os.environ["PUBLISH_UID"]), int(os.environ["PUBLISH_GID"]),
        lines(os.environ.get("PUBLISH_ENV", "")),
    )
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key in ("image", "digest", "seconds"):
            output.write(f"{key}={metrics[key]}\n")
        output.write(f"runtime-cache-miss={str(metrics['runtimeCacheMiss']).lower()}\n")


if __name__ == "__main__":
    main()
