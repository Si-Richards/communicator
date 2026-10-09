-module(voicehost_rooms_tests).
-include_lib("eunit/include/eunit.hrl").
-include_lib("xmpp/include/xmpp.hrl").
-define(H,<<"ejabberd.voicehost.io">>).
-define(R,<<"vh-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">>).
-define(A,<<"10000*213">>).
-define(B,<<"10000*230">>).
-define(C,<<"10000*231">>).
rooms_test_() -> {setup,fun setup/0,fun cleanup/1,fun(_) -> cases() end}.
setup() ->
    ok=mnesia:create_schema([node()]),ok=application:start(mnesia),
    {ok,_}=mod_voicehost_tenants:start(?H,[]),ok=mod_muc_admin:reset(),
    lists:foreach(fun({U,A,E,On}) -> 0=mod_voicehost_tenants:set_identity(U,?H,A,E,E,E,On) end,
      [{?A,<<"10000">>,<<"213">>,1},{?B,<<"10000">>,<<"230">>,1},{?C,<<"10000">>,<<"231">>,1},
       {<<"20000*230">>,<<"20000">>,<<"230">>,1},{<<"10000*232">>,<<"10000">>,<<"232">>,0}]),ok.
cleanup(_) -> application:stop(mnesia),mnesia:delete_schema([node()]),mod_muc_admin:reset().
j(U) -> jid:make(U,?H).
r() -> jid:make(?R,voicehost_rooms:room_host(?H)).
change(U,Action,Target,Value,V) -> voicehost_rooms:manage(U,?H,?R,Action,Target,Value,V).
cases() ->
    [?_assertEqual(1,voicehost_rooms:create(?A,?H,?R,<<"Team">>,<<"20000*230">>)),
     ?_assertEqual(1,voicehost_rooms:create(?A,?H,?R,<<"Team">>,<<"10000*232">>)),
     ?_assertEqual(1,voicehost_rooms:create(?A,?H,<<"bad">>,<<"Team">>,?B)),
     ?_assertEqual(0,voicehost_rooms:create(?A,?H,?R,<<"Team">>,?B)),
     ?_test(begin
        [{JID,<<"Team">>,1,Members}]=voicehost_rooms:list(?B,?H),
        ?assertEqual(jid:encode(r()),JID),?assertEqual(2,length(Members)),
        ?assertEqual([],voicehost_rooms:list(<<"20000*230">>,?H)),
        ?assert(voicehost_rooms:member(j(?A),r())),
        ?assertEqual([],voicehost_rooms:list(?C,?H))
     end),
     ?_test(begin
        P=#message{type=groupchat,from=j(?A),to=r(),body=[#text{data= <<"hello">>}]},
        ?assertEqual(P,mod_voicehost_tenants:filter_packet(P)),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P#message{from=j(?C)})),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P#message{from=j(<<"20000*230">>)})),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P#message{subject=[#text{data= <<"rename">>}]})),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P#message{sub_els=[#muc_user{invites=[#muc_invite{to=j(?C)}]}]})),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P#message{type=chat,to=jid:replace_resource(r(),<<"230">>)})),
        Pres=#presence{from=j(?A),to=jid:replace_resource(r(),<<"213">>)},
        ?assertEqual(Pres,mod_voicehost_tenants:filter_packet(Pres)),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(Pres#presence{to=jid:replace_resource(r(),<<"230">>)})),
        Query=#iq{type=set,from=j(?B),to=r(),sub_els=[#mam_query{xmlns= <<"urn:xmpp:mam:2">>}]},
        ?assertEqual(Query,mod_voicehost_tenants:filter_packet(Query)),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(Query#iq{from=j(?C)})),
        ?assertEqual(drop,mod_voicehost_tenants:filter_packet(Query#iq{sub_els=[#muc_admin{}]}))
     end),
     ?_assertEqual(1,change(?B,<<"add">>,?C,<<>>,1)),
     ?_assertEqual(1,change(?A,<<"leave">>,<<>>,<<>>,1)),
     ?_assertEqual(0,change(?A,<<"role">>,?B,<<"admin">>,1)),
     ?_assertEqual(3,change(?A,<<"rename">>,<<>>,<<"stale">>,1)),
     ?_assertEqual(1,change(?B,<<"remove">>,?A,<<>>,2)),
     ?_assertEqual(0,change(?B,<<"add">>,?C,<<>>,2)),
     ?_test(begin
       ?assert(voicehost_rooms:member(j(?C),r())),
       Node= <<"vh-",(binary:copy(<<"a">>,64))/binary>>,
       IQ=#iq{from=jid:make(?H),to=jid:make(?H),sub_els=[#pubsub{publish=#ps_publish{node=Node}}]},
       Msg=#message{type=groupchat,from=jid:replace_resource(r(),<<"213">>),to=j(?B),
                    id= <<"m1">>,body=[#text{data= <<"hello">>}]},
       ?assertEqual(drop,mod_voicehost_tenants:push_send(IQ,Msg)),
       [{_,Node,_,Peer,_}]=mod_voicehost_tenants:push_events(?H,100),?assertEqual(jid:encode(r()),Peer),
       ?assertEqual(drop,mod_voicehost_tenants:push_send(IQ,Msg#message{to=j(?A)})),
       ?assertEqual(1,length(mod_voicehost_tenants:push_events(?H,100)))
     end),
     ?_test(begin
       persistent_term:put(voicehost_native_fail,true),
       ?assertEqual(2,change(?A,<<"remove">>,?C,<<>>,3)),
       ?assertNot(voicehost_rooms:member(j(?A),r())),
       persistent_term:put(voicehost_native_fail,false),?assertEqual(0,voicehost_rooms:repair(?H)),
       ?assert(voicehost_rooms:member(j(?A),r())),?assertNot(voicehost_rooms:member(j(?C),r())),
       ?assertNot(lists:any(fun({U,_,_,_})->U=:=?C end,mod_muc_admin:get_room_affiliations(?R,voicehost_rooms:room_host(?H))))
     end),
     ?_assertEqual(0,change(?A,<<"role">>,?B,<<"owner">>,4)),
     ?_assertEqual(0,change(?A,<<"leave">>,<<>>,<<>>,5)),
     ?_test(begin
       ?assertNot(voicehost_rooms:member(j(?A),r())),
       P=#message{type=groupchat,from=jid:replace_resource(r(),<<"230">>),to=j(?A)},
       ?assertEqual(drop,mod_voicehost_tenants:filter_packet(P))
     end),
     ?_test(begin
       0=mod_voicehost_tenants:set_identity(?B,?H,<<"10000">>,<<"230">>,<<"230">>,<<"230">>,0),
       ?assertNot(voicehost_rooms:member(j(?B),r())),?assertEqual([],voicehost_rooms:list(?B,?H)),
       0=mod_voicehost_tenants:set_identity(?B,?H,<<"10000">>,<<"230">>,<<"230">>,<<"230">>,1)
     end),
     ?_assertEqual(0,change(?B,<<"close">>,<<>>,<<>>,6)),
     ?_assertEqual([],voicehost_rooms:list(?B,?H))].
