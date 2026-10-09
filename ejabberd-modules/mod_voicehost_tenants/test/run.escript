#!/usr/bin/env escript
%% Run against an installed ejabberd's headers and XMPP library. This starts
%% only a temporary Mnesia node, never connects to a running ejabberd node.
-mode(compile).
main([IncludeDir]) ->
    Root = filename:dirname(filename:dirname(escript:script_name())),
    Out = filename:join(Root, "test-ebin"),
    ok = filelib:ensure_dir(filename:join(Out, "placeholder")),
    true = code:add_patha(Out),
    Options = [report, return_errors, return_warnings, {i, IncludeDir}, {outdir, Out}],
    compile(filename:join([Root,"test","gen_mod.erl"]), Options),
    lists:foreach(fun(F) -> compile(filename:join([Root,"test",F]),Options) end, ["mod_muc.erl","mod_muc_admin.erl"]),
    compile(filename:join([Root,"src","voicehost_rooms.erl"]), Options),
    code:purge(gen_mod), code:delete(gen_mod),
    {module,gen_mod} = code:load_file(gen_mod),
    compile(filename:join([Root,"src","mod_voicehost_tenants.erl"]), Options),
    compile(filename:join([Root,"test","mod_voicehost_tenants_tests.erl"]), Options),
    compile(filename:join([Root,"test","voicehost_rooms_tests.erl"]), Options),
    Dir = filename:join("/tmp", "voicehost-mnesia-" ++ integer_to_list(erlang:unique_integer([positive]))),
    application:set_env(mnesia, dir, Dir),
    {ok,_} = application:ensure_all_started(stringprep),
    ok = jid:start(),
    Result = eunit:test([mod_voicehost_tenants_tests,voicehost_rooms_tests], [verbose]),
    file:del_dir_r(Dir),
    halt(case Result of ok -> 0; _ -> 1 end);
main(_) -> io:format("Usage: run.escript /path/to/ejabberd/include (set ERL_LIBS to ejabberd's libraries)~n"), halt(2).
compile(File, Options) ->
    case compile:file(File, Options) of
        {ok,_,[]} -> ok;
        Other -> io:format("Compilation failed: ~p~n",[Other]), halt(1)
    end.
