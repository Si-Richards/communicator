-module(mod_voicehost_tenants_tests).
-include_lib("eunit/include/eunit.hrl").
-include_lib("xmpp/include/xmpp.hrl").
-include("mod_roster.hrl").

-define(HOST, <<"ejabberd.voicehost.io">>).

isolation_test_() ->
    {setup, fun setup/0, fun cleanup/1, fun(_) -> cases() end}.

setup() ->
    ok = mnesia:create_schema([node()]),
    ok = application:start(mnesia),
    {ok, _} = mod_voicehost_tenants:start(?HOST, []),
    0 = publish(<<"10000*207">>, <<"10000">>, <<"207">>, <<"Simon">>, 1),
    0 = publish(<<"10000*208">>, <<"10000">>, <<"208">>, <<"Reception">>, 1),
    0 = publish(<<"20000*207">>, <<"20000">>, <<"207">>, <<"Other tenant">>, 1),
    0 = publish(<<"10000*209">>, <<"10000">>, <<"209">>, <<"Disabled">>, 0),
    ok.

cleanup(_) ->
    application:stop(mnesia),
    mnesia:delete_schema([node()]).

publish(User, Account, Ext, Name, Enabled) ->
    mod_voicehost_tenants:set_identity(User, ?HOST, Account, Ext, Name, Ext, Enabled).

jid(User) -> jid(User, ?HOST).
jid(User, Host) -> #jid{user=User, server=Host, luser=User, lserver=Host}.

cases() ->
    A = jid(<<"10000*207">>), B = jid(<<"10000*208">>), C = jid(<<"20000*207">>),
    Unknown = jid(<<"10000*999">>), Disabled = jid(<<"10000*209">>),
    SameMsg = #message{type=chat, from=A, to=B},
    CrossMsg = #message{type=chat, from=A, to=C},
    State = #{jid => A},
    Roster = mod_voicehost_tenants:roster_get([], <<"10000*207">>, ?HOST),
    [?_assertEqual(SameMsg, mod_voicehost_tenants:filter_packet(SameMsg)),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg)),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{from=C,to=A})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{to=Unknown})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{from=Unknown,to=A})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{to=Disabled})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{from=Disabled,to=A})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{to=jid(<<"user">>,<<"remote.example">>)})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(CrossMsg#message{from=jid(<<"user">>,<<"remote.example">>),to=A})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#presence{type=subscribe,from=A,to=C})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#presence{from=C,to=A})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#iq{type=get,from=A,to=C,sub_els=[#vcard_temp{}]})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#iq{type=get,from=A,to=C,sub_els=[#last{}]})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#presence{from=A,to=jid(<<"room">>,<<"conference.ejabberd.voicehost.io">>)})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#iq{type=get,from=A,to=jid(<<>>),sub_els=[#disco_items{}]})),
     ?_assertEqual(drop, mod_voicehost_tenants:filter_packet(#iq{type=set,from=A,to=A,sub_els=[#roster_query{}]})),
     ?_assertEqual({stop,{drop,State}}, mod_voicehost_tenants:user_send({CrossMsg#message{from=C,to=C},State})),
     ?_assertEqual(true, mod_voicehost_tenants:filter_packet(#iq{type=get,from=A,to=A,sub_els=[#roster_query{}]}) =/= drop),
     ?_assertEqual(true, mod_voicehost_tenants:filter_packet(#iq{type=get,from=A,to=jid(<<>>),sub_els=[#ping{}]}) =/= drop),
     ?_assertEqual({stop,{drop,State}}, mod_voicehost_tenants:user_send({CrossMsg,State})),
     ?_assertEqual({stop,{drop,State}}, mod_voicehost_tenants:user_receive({CrossMsg#message{from=C,to=A},State})),
     ?_assertEqual({SameMsg,State}, mod_voicehost_tenants:user_receive({SameMsg,State})),
     ?_assertEqual(1, length(Roster)),
     ?_assertEqual({<<"10000*208">>,?HOST,<<>>}, (hd(Roster))#roster.jid),
     ?_assertEqual(<<"Reception">>, (hd(Roster))#roster.name),
     ?_assertEqual([], mod_voicehost_tenants:roster_get(Roster,<<"10000*999">>,?HOST)),
     ?_assertEqual({both,none,[<<"Account users">>]},mod_voicehost_tenants:roster_info({none,none,[]},<<"10000*207">>,?HOST,B)),
     ?_assertEqual({none,none,[]},mod_voicehost_tenants:roster_info({both,none,[]},<<"10000*207">>,?HOST,C)),
     ?_assertEqual(1,publish(<<"10000*207">>,<<"20000">>,<<"207">>,<<"Forgery">>,1)),
     ?_assertEqual(1,mod_voicehost_tenants:set_identity(<<"10000*208t">>,?HOST,<<"10000">>,<<"208t">>,<<"Duplicate">>,<<"208">>,1)),
     ?_assertEqual(0,mod_voicehost_tenants:set_identity(<<"10000*213t">>,?HOST,<<"10000">>,<<"213t">>,<<"Simon">>,<<"213">>,1)),
     ?_assertEqual(true,lists:any(fun(R) -> lists:member(<<"VoiceHost extension:213">>,R#roster.groups) end,
                                mod_voicehost_tenants:roster_get([],<<"10000*207">>,?HOST))),
     ?_assertEqual(0,mod_voicehost_tenants:set_identity(<<"10000*213t">>,?HOST,<<"10000">>,<<"213t">>,<<"Simon">>,<<"213">>,0)),
     ?_assertEqual(false,mod_voicehost_tenants:valid_identity(<<"10000*207*other">>,<<"10000">>,<<"207*other">>)),
     ?_assertEqual(false,mod_voicehost_tenants:valid_identity(<<"207">>,<<>>,<<"207">>)),
     ?_assertEqual(0,publish(<<"10000*208">>,<<"10000">>,<<"208">>,<<"Reception">>,1)),
     ?_assertEqual(1,length(mod_voicehost_tenants:roster_get([],<<"10000*207">>,?HOST))),
     ?_assertEqual(0,publish(<<"10000*208">>,<<"10000">>,<<"208">>,<<"Reception">>,0)),
     ?_assertEqual(drop,mod_voicehost_tenants:filter_packet(SameMsg)),
     ?_assertEqual([],mod_voicehost_tenants:roster_get([],<<"10000*207">>,?HOST))].
