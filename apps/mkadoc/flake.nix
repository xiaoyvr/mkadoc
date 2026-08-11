{
  description = "mkadoc — build and serve AsciiDoc as a static site";

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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          lib = pkgs.lib;

          mkadoc =
            (pkgs.buildNpmPackage.override {
              nodejs = pkgs.nodejs_24;
            })
              {
                pname = "mkadoc";
                version = "0.1.0";

                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.unions [
                    ./bin
                    ./src
                    ./package.json
                    ./package-lock.json
                  ];
                };

                npmDepsHash = "sha256-a5GM6humsvM5dN7PhtZ/QJYnWuzWNle0QwfWt2MAq54=";

                dontNpmBuild = true;

                meta = {
                  description = "Build and serve AsciiDoc as a static site";
                  mainProgram = "mkadoc";
                  platforms = systems;
                };
              };
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

      checks = forAllSystems (system: {
        mkadoc = self.packages.${system}.default;
      });
    };
}
