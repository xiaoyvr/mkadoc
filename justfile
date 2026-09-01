# mkadoc monorepo — site workflow, always from source (no nix-built CLI).
# Recipe set mirrors the README's Site section; requires `just deps` once.

default:
    @just --list

deps: # npm install for all packages
    npm --prefix apps/mkadoc install
    npm --prefix apps/mkadoc-plugin-host install
    npm --prefix apps/mkadoc-plugin-kroki install

check: # validate config + plugins (reports Kroki reachability)
    node apps/mkadoc/bin/mkadoc.js check

build: # render site/ (no server needed; diagrams fall back to listings)
    node apps/mkadoc/bin/mkadoc.js build

serve *args: # live-reload preview; extra args forwarded (e.g. --port 9000)
    node apps/mkadoc/bin/mkadoc.js serve {{args}}

flake-hash: # recompute npmDepsHash in apps/mkadoc/flake.nix after a dependency change
    @hash=$(nix run nixpkgs#prefetch-npm-deps -- apps/mkadoc/package-lock.json 2>/dev/null | tail -1) && \
    test -n "$hash" && \
    sed -i "s|npmDepsHash = \"sha256-[^\"]*\"|npmDepsHash = \"$hash\"|" apps/mkadoc/flake.nix && \
    echo "npmDepsHash updated in apps/mkadoc/flake.nix: $hash"
