{
  description = "mkadoc — build and serve documentation as a static site";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      perSystem = system: rec {
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        buildNpmPackage = pkgs.buildNpmPackage.override {
          nodejs = pkgs.nodejs_24;
        };

        version = "1.0.0";
        npmDepsHash =  "sha256-FVPQ34UN+6unyf0VxVOdbxVPUs4b0RDIqOCtsmAWfKA=";

        packageFileset = lib.fileset.unions [
          ./bin
          ./src
          ./package.json
          ./package-lock.json
        ];

        # Includes tests; used only by the check derivation so test-only edits
        # do not rebuild the installable `mkadoc` package.
        testFileset = lib.fileset.unions [
          packageFileset
          ./test
        ];

        mkadoc = buildNpmPackage {
          pname = "mkadoc";
          inherit version npmDepsHash;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = packageFileset;
          };

          dontNpmBuild = true;
          npmFlags = [ "--omit=dev" ];

          meta = {
            description = "Build and serve documentation as a static site";
            mainProgram = "mkadoc";
            platforms = systems;
          };
        };

        mkadoc-test = buildNpmPackage {
          pname = "mkadoc-test";
          inherit version npmDepsHash;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = testFileset;
          };

          dontNpmBuild = true;

          installPhase = ''
            runHook preInstall
            npm test
            mkdir -p "$out"
            touch "$out/passed"
            runHook postInstall
          '';

          meta = {
            description = "mkadoc test suite";
            platforms = systems;
          };
        };
      };
    in
    {
      packages = forAllSystems (
        system:
        let
          inherit (perSystem system) mkadoc;
        in
        {
          default = mkadoc;
          inherit mkadoc;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/mkadoc";
        };
      });

      checks = forAllSystems (
        system:
        let
          inherit (perSystem system) mkadoc mkadoc-test;
        in
        {
          inherit mkadoc mkadoc-test;
        }
      );
    };
}
