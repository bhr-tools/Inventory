{
  description = "Inventory — where every part and tool lives, box by box";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Supported systems
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];

      # Package definitions per architecture
      systemOutputs = flake-utils.lib.eachSystem supportedSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          packages = rec {
            inventory = pkgs.buildGoModule {
              pname = "inventory";
              version = "0.1.0";
              src = ./.;

              subPackages = [ "cmd/server" ];
              vendorHash = null;

              postInstall = ''
                if [ -f "$out/bin/server" ]; then
                  mv "$out/bin/server" "$out/bin/inventory"
                fi
              '';

              meta = with pkgs.lib; {
                description = "Inventory — where every part and tool lives, box by box";
                homepage = "https://github.com/bhr-tools/Inventory";
                license = licenses.mit;
                mainProgram = "inventory";
              };
            };
            default = inventory;
          };

          apps = rec {
            inventory = flake-utils.lib.mkApp {
              drv = self.packages.${system}.inventory;
              name = "inventory";
            };
            default = inventory;
          };

          devShells.default = pkgs.mkShell {
            buildInputs = with pkgs; [
              go
              gopls
              sqlite
            ];
          };
        }
      );

      # Native multi-instance NixOS module for server / desktop
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.inventory;
        in
        {
          options.services.inventory = {
            enable = lib.mkEnableOption "Inventory Server & Web Daemon";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              description = "The Inventory package to use.";
            };

            instances = lib.mkOption {
              type = lib.types.attrsOf (lib.types.submodule ({ name, config, ... }: {
                options = {
                  port = lib.mkOption {
                    type = lib.types.port;
                    description = "HTTP listening port for this Inventory instance.";
                  };

                  host = lib.mkOption {
                    type = lib.types.str;
                    default = "127.0.0.1";
                    description = "IP address on which the instance listens.";
                  };

                  dataDir = lib.mkOption {
                    type = lib.types.path;
                    default = if (name == "default" || name == "perso") then "/var/lib/inventory" else "/var/lib/inventory-${name}";
                    description = "Data directory of the Inventory instance.";
                  };

                  dbPath = lib.mkOption {
                    type = lib.types.path;
                    default = "${config.dataDir}/inventory.db";
                    description = "Path to the SQLite database for this instance.";
                  };

                  noAuth = lib.mkOption {
                    type = lib.types.bool;
                    default = false;
                    description = "Disable password authentication.";
                  };

                  user = lib.mkOption {
                    type = lib.types.str;
                    default = "inventory";
                    description = "System user under which to run the instance.";
                  };

                  group = lib.mkOption {
                    type = lib.types.str;
                    default = "inventory";
                    description = "System group under which to run the instance.";
                  };

                  openFirewall = lib.mkOption {
                    type = lib.types.bool;
                    default = false;
                    description = "Automatically open the port in the NixOS firewall.";
                  };
                };
              }));
              default = {};
              description = "Definition of independent Inventory instances.";
            };
          };

          config = lib.mkIf (cfg.enable && cfg.instances != {}) {
            networking.firewall.allowedTCPPorts = lib.concatLists (
              lib.mapAttrsToList (_: inst: lib.optional inst.openFirewall inst.port) cfg.instances
            );

            users.users = lib.mkIf (lib.any (inst: inst.user == "inventory") (lib.attrValues cfg.instances)) {
              inventory = {
                isSystemUser = true;
                group = "inventory";
                home = "/var/lib/inventory";
                createHome = true;
                description = "Inventory daemon user";
              };
            };

            users.groups = lib.mkIf (lib.any (inst: inst.group == "inventory") (lib.attrValues cfg.instances)) {
              inventory = {};
            };

            systemd.services = lib.mapAttrs' (name: inst:
              let
                serviceName = if name == "default" then "inventory" else "inventory-${name}";
              in
              lib.nameValuePair serviceName {
                description = "Inventory Daemon (${name})";
                after = [ "network.target" ];
                wantedBy = [ "multi-user.target" ];

                serviceConfig = {
                  ExecStart = "${cfg.package}/bin/inventory -host ${inst.host} -port ${toString inst.port} -data-dir ${toString inst.dataDir} -db ${toString inst.dbPath}"
                    + lib.optionalString inst.noAuth " -no-auth";
                  Restart = "always";
                  RestartSec = 3;
                  User = inst.user;
                  Group = inst.group;
                  WorkingDirectory = toString inst.dataDir;
                  ReadWritePaths = [ (toString inst.dataDir) ];
                  # Hardening: the service only needs its data directory and the network.
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  PrivateDevices = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                  ProtectKernelTunables = true;
                  ProtectKernelModules = true;
                  ProtectControlGroups = true;
                  RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
                  RestrictNamespaces = true;
                  LockPersonality = true;
                  MemoryDenyWriteExecute = true;
                  SystemCallArchitectures = "native";
                } // lib.optionalAttrs (lib.hasPrefix "/var/lib/" (toString inst.dataDir)) {
                  # systemd creates and owns the directory when it lives under /var/lib.
                  StateDirectory = lib.removePrefix "/var/lib/" (toString inst.dataDir);
                };
              }
            ) cfg.instances;
          };
        };
    in
    systemOutputs // {
      nixosModules.default = nixosModule;
      nixosModules.inventory = nixosModule;
      overlays.default = final: prev: {
        inventory = self.packages.${final.stdenv.hostPlatform.system}.default;
      };
    };
}
