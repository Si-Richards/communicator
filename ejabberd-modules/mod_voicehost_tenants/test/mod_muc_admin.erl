%% Test-only native MUC boundary with failure injection; never install.
-module(mod_muc_admin).
-export([get_room_options/2,change_room_option/4,get_room_affiliations/2,
         set_room_affiliation/5,subscribe_room/6,unsubscribe_room/4,destroy_room/2,put/3,reset/0]).
reset() -> persistent_term:put(voicehost_native_rooms,#{}), persistent_term:erase(voicehost_native_fail), ok.
get(R,S) -> maps:get({R,S},persistent_term:get(voicehost_native_rooms,#{})).
put(R,S,V) ->
    false=persistent_term:get(voicehost_native_fail,false),
    persistent_term:put(voicehost_native_rooms,(persistent_term:get(voicehost_native_rooms,#{}))#{{R,S}=>V}),ok.
get_room_options(R,S) -> case catch get(R,S) of #{options:=O} -> O; _ -> [] end.
change_room_option(R,S,K,V) ->
    Room=get(R,S), Key=binary_to_existing_atom(K,utf8),
    true=lists:member(Key,[title,persistent,members_only,public,public_list,anonymous,mam,
                         allow_subscription,moderated,members_by_default,allow_user_invites,
                         allow_change_subj,allowpm,max_users]),
    put(R,S,Room#{options=>lists:keystore(Key,1,maps:get(options,Room),{Key,V})}).
get_room_affiliations(R,S) -> [{U,H,Role,<<>>} || {{U,H},Role} <- maps:to_list(maps:get(affiliations,get(R,S)))].
set_room_affiliation(R,S,U,H,Role) ->
    Room=get(R,S), A=maps:get(affiliations,Room),
    New=case Role of <<"none">> -> maps:remove({U,H},A); _ -> A#{{U,H}=>binary_to_existing_atom(Role,utf8)} end,
    put(R,S,Room#{affiliations=>New}).
subscribe_room(U,H,Nick,R,S,Nodes) ->
    Room=get(R,S), Subs=maps:get(subscribers,Room),
    ok=put(R,S,Room#{subscribers=>Subs#{{U,H}=>Nick}}),[Nodes].
unsubscribe_room(U,H,R,S) ->
    Room=get(R,S),put(R,S,Room#{subscribers=>maps:remove({U,H},maps:get(subscribers,Room))}).
destroy_room(R,S) -> persistent_term:put(voicehost_native_rooms,maps:remove({R,S},persistent_term:get(voicehost_native_rooms))),ok.
