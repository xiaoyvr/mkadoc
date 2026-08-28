{
  description = "mkadoc monorepo — build and serve AsciiDoc as a static site";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # The mkadoc app flake packages the CLI and its test suite; the root
    # flake re-exports it and exposes it in the devShell.
    mkadoc = {
      url = "path:./apps/mkadoc";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      mkadoc,
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      mkDevShell =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.nixfmt
            mkadoc.packages.${system}.default
          ];
        };
    in
    {
      # Re-export the mkadoc package so the monorepo root is usable as a
      # flake input too (e.g. github:xiaoyvr/mkadoc).
      packages = forAllSystems (system: {
        default = mkadoc.packages.${system}.default;
        inherit (mkadoc.packages.${system}) mkadoc;
      });

      apps = forAllSystems (system: {
        default = mkadoc.apps.${system}.default;
      });

      checks = forAllSystems (system: mkadoc.checks.${system});

      devShells = forAllSystems (system: {
        default = mkDevShell system;
      });
    };
}
