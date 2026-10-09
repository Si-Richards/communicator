%% Test-only native MUC boundary. Never installed by install.sh.
-module(mod_muc).
-export([create_room/3]).
create_room(Service,Room,Options) -> mod_muc_admin:put(Room,Service,#{options=>Options,affiliations=>#{},subscribers=>#{}}).
