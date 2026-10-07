%% Test-only host registry; never install this module into ejabberd.
-module(gen_mod).
-export([is_loaded/2, behaviour_info/1]).
is_loaded(<<"ejabberd.voicehost.io">>, mod_voicehost_tenants) -> true;
is_loaded(_, _) -> false.
behaviour_info(callbacks) -> [{start,2},{stop,1},{depends,2},{mod_options,1},{mod_doc,0}];
behaviour_info(_) -> undefined.
