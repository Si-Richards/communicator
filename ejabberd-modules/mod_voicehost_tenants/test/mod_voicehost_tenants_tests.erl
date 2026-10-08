-module(mod_voicehost_tenants_tests).
-include_lib("eunit/include/eunit.hrl").
-include_lib("xmpp/include/xmpp.hrl").
-include("mod_roster.hrl").
-include("mod_mam.hrl").

-define(HOST, <<"ejabberd.voicehost.io">>).

isolation_test_() ->
    {setup, fun setup/0, fun cleanup/1, fun(_) -> cases() end}.

history_migration_test_() ->
    {setup, fun history_setup/0, fun cleanup/1, fun(_) -> history_cases() end}.

history_setup() ->
    ok = mnesia:create_schema([node()]),
    ok = application:start(mnesia),
    {ok, _} = mod_voicehost_tenants:start(?HOST, []),
    {atomic,ok} = mnesia:create_table(archive_msg, [{disc_copies,[node()]},{type,bag},
                                                 {attributes,record_info(fields,archive_msg)}]),
    0 = publish(<<"10000*213t">>, <<"10000">>, <<"213t">>, <<"Legacy">>, 0),
    0 = publish(<<"10000*213">>, <<"10000">>, <<"213">>, <<"Simon">>, 0),
    Source = [archive(<<"10000*213t">>, <<"10000*230d">>, 1, <<"Incoming">>, recv),
              archive(<<"10000*213t">>, <<"10000*230d">>, 2, <<"Outgoing">>, send),
              archive(<<"10000*213t">>, <<"20000*230">>, 3, <<"Foreign">>, recv),
              (archive(<<"10000*213t">>, <<"10000*230">>, 4, <<"Old room">>, recv))#archive_msg{type=groupchat}],
    lists:foreach(fun mnesia:dirty_write/1, Source),
    ok.

archive(User, Peer, ID, Body, Direction) ->
    OwnJid = <<User/binary,"@",?HOST/binary>>,
    PeerJid = <<Peer/binary,"@",?HOST/binary>>,
    {From,To} = case Direction of send -> {OwnJid,PeerJid}; recv -> {PeerJid,OwnJid} end,
    #archive_msg{us={User,?HOST},id=integer_to_binary(ID),timestamp={0,0,ID},
                 peer={Peer,?HOST,<<>>},bare_peer={Peer,?HOST,<<>>},origin_id=integer_to_binary(ID),
                 packet=#xmlel{name = <<"message">>,attrs=[{<<"xmlns">>,<<"jabber:client">>},{<<"from">>,From},{<<"to">>,To}],
                               children=[#xmlel{name = <<"body">>,children=[{xmlcdata,Body}]},
                                         #xmlel{name = <<"stanza-id">>,attrs=[{<<"xmlns">>,<<"urn:xmpp:sid:0">>},{<<"by">>,OwnJid},{<<"id">>,integer_to_binary(ID)}]}]}}.

history_cases() ->
    [?_assertEqual({ok,<<"00100*01234">>,<<"00100">>},mod_voicehost_tenants:canonical_user(<<"00100*01234t">>)),
     ?_assertEqual(error,mod_voicehost_tenants:canonical_user(<<"10000*12">>)),
     ?_assertEqual(error,mod_voicehost_tenants:canonical_user(<<"10000*123456">>)),
     ?_assertEqual(error,mod_voicehost_tenants:canonical_user(<<"10000*213t2">>)),
     ?_assertEqual(1,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"20000*213">>,?HOST)),
     ?_assertEqual(1,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"10000*214">>,?HOST)),
     ?_assertEqual(0,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"10000*213">>,?HOST)),
     ?_test(begin
         Target = mnesia:dirty_read(archive_msg,{<<"10000*213">>,?HOST}),
         ?assertEqual(2,length(Target)),
         ?assertEqual(4,length(mnesia:dirty_read(archive_msg,{<<"10000*213t">>,?HOST}))),
         ?assert(lists:all(fun(M) -> M#archive_msg.bare_peer =:= {<<"10000*230">>,?HOST,<<>>} end,Target)),
         [Incoming] = [M || M <- Target, M#archive_msg.id =:= <<"1">>],
         ?assertEqual(<<"10000*230@ejabberd.voicehost.io">>,proplists:get_value(<<"from">>,(Incoming#archive_msg.packet)#xmlel.attrs)),
         ?assertEqual(<<"10000*213@ejabberd.voicehost.io">>,proplists:get_value(<<"to">>,(Incoming#archive_msg.packet)#xmlel.attrs))
     end),
     ?_test(begin
         ?assertEqual(0,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"10000*213">>,?HOST)),
         ?assertEqual(2,length(mnesia:dirty_read(archive_msg,{<<"10000*213">>,?HOST})))
     end),
     ?_test(begin
         0 = publish(<<"10000*213t">>,<<"10000">>,<<"213t">>,<<"Legacy">>,1),
         ?assertEqual(1,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"10000*213">>,?HOST)),
         0 = publish(<<"10000*213t">>,<<"10000">>,<<"213t">>,<<"Legacy">>,0)
     end),
     ?_test(begin
         persistent_term:put(voicehost_test_mam_backend,mod_mam_sql),
         try ?assertEqual(3,mod_voicehost_tenants:migrate_history(<<"10000*213t">>,<<"10000*213">>,?HOST))
         after persistent_term:erase(voicehost_test_mam_backend) end
     end),
     ?_test(begin
         0 = publish(<<"10000*216d">>,<<"10000">>,<<"216d">>,<<"Legacy">>,0),
         0 = publish(<<"10000*216">>,<<"10000">>,<<"216">>,<<"User">>,0),
         lists:foreach(fun(I) -> mnesia:dirty_write(archive(<<"10000*216d">>,<<"10000*230t">>,1000+I,<<"Message">>,send)) end,lists:seq(1,501)),
         ?assertEqual(2,mod_voicehost_tenants:migrate_history(<<"10000*216d">>,<<"10000*216">>,?HOST)),
         ?assertEqual(500,length(mnesia:dirty_read(archive_msg,{<<"10000*216">>,?HOST}))),
         ?assertEqual(0,mod_voicehost_tenants:migrate_history(<<"10000*216d">>,<<"10000*216">>,?HOST)),
         ?assertEqual(501,length(mnesia:dirty_read(archive_msg,{<<"10000*216">>,?HOST}))),
         ?assertEqual(0,mod_voicehost_tenants:migrate_history(<<"10000*216d">>,<<"10000*216">>,?HOST)),
         ?assertEqual(501,length(mnesia:dirty_read(archive_msg,{<<"10000*216">>,?HOST})))
     end),
     ?_test(begin
         0 = publish(<<"10000*217t">>,<<"10000">>,<<"217t">>,<<"Legacy">>,0),
         0 = publish(<<"10000*217">>,<<"10000">>,<<"217">>,<<"User">>,0),
         mnesia:dirty_write(archive(<<"10000*217t">>,<<"10000*230">>,10,<<"Old">>,send)),
         mnesia:dirty_write(archive(<<"10000*217">>,<<"10000*230">>,10,<<"Different">>,send)),
         ?assertEqual(1,mod_voicehost_tenants:migrate_history(<<"10000*217t">>,<<"10000*217">>,?HOST)),
         ?assertEqual(1,length(mnesia:dirty_read(archive_msg,{<<"10000*217">>,?HOST}))),
         ?assertEqual(1,length(mnesia:dirty_read(archive_msg,{<<"10000*217t">>,?HOST})))
     end)].

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
