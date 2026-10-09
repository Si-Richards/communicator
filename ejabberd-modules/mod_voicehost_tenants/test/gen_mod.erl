%% Test-only host registry; never install this module into ejabberd.
-module(gen_mod).
-export([is_loaded/2, behaviour_info/1, db_mod/2]).
is_loaded(<<"ejabberd.voicehost.io">>, mod_voicehost_tenants) -> true;
is_loaded(<<"ejabberd.voicehost.io">>, mod_mam) -> true;
is_loaded(_, _) -> false.
db_mod(_, mod_mam) -> persistent_term:get(voicehost_test_mam_backend,mod_mam_mnesia).
behaviour_info(callbacks) -> [{start,2},{stop,1},{depends,2},{mod_options,1},{mod_doc,0}];
behaviour_info(_) -> undefined.
