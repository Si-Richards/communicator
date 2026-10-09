%% Provisioning-owned, account-scoped MUC membership. Never trust client roles.
-module(voicehost_rooms).
-include_lib("xmpp/include/xmpp.hrl").
-export([init/0, create/5, manage/7, list/2, repair/1, allowed/1,
         room_host/1, room_key/1, member/2]).
-record(voicehost_identity, {key, account, extension, address, name, enabled = false}).
-record(voicehost_room, {key, account, name, members = #{}, revision = 1,
                        ready = false, closed = false}).

init() ->
    case mnesia:create_table(voicehost_room,
          [{disc_copies,[node()]},{attributes,record_info(fields,voicehost_room)},
           {index,[account]}]) of
        {atomic,ok} -> ok;
        {aborted,{already_exists,voicehost_room}} -> ok;
        Other -> error({voicehost_room_table,Other})
    end,
    ok = mnesia:wait_for_tables([voicehost_room],30000).

room_host(Host) -> <<"rooms.",Host/binary>>.
room_key(#jid{luser=Room,lserver= <<"rooms.",Host/binary>>}) ->
    case valid_room(Room) andalso gen_mod:is_loaded(Host,mod_voicehost_tenants) of
        true -> {Host,Room}; false -> false
    end;
room_key(_) -> false.
valid_room(Room) when is_binary(Room) ->
    re:run(Room,<<"\\Avh-[a-f0-9]{32}\\z">>,[{capture,none}]) =:= match;
valid_room(_) -> false.

entry(User,Host) ->
    case catch mnesia:dirty_read(voicehost_identity,{Host,User}) of
        [#voicehost_identity{enabled=true}=E] -> E;
        _ -> error(denied)
    end.
read(Key) ->
    case mnesia:dirty_read(voicehost_room,Key) of
        [R] -> R; _ -> error(denied)
    end.
member(#jid{luser=U,lserver=H},#voicehost_room{key={H,_},account=A,members=M,ready=true,closed=false}) ->
    case catch entry(U,H) of
        #voicehost_identity{account=A} -> maps:is_key(U,M);
        _ -> false
    end;
member(JID,RoomJID) when is_record(RoomJID,jid) ->
    case room_key(RoomJID) of false -> false; Key ->
        case catch read(Key) of R when is_record(R,voicehost_room) -> member(JID,R); _ -> false end
    end;
member(_,_) -> false.

%% Return undefined for packets outside our service; false for unknown rooms.
allowed(Packet) ->
    From=xmpp:get_from(Packet), To=xmpp:get_to(Packet),
    case {room_key(From),room_key(To)} of
        {false,false} ->
            case is_service(From) orelse is_service(To) of true -> false; false -> undefined end;
        {false,Key} ->
            case catch read(Key) of
                R when is_record(R,voicehost_room) -> member(From,R) andalso safe_client_packet(Packet,R);
                _ -> false
            end;
        {Key,false} ->
            case catch read(Key) of
                R when is_record(R,voicehost_room) -> member(To,R);
                _ -> false
            end;
        _ -> false
    end.
is_service(#jid{lserver= <<"rooms.",H/binary>>}) -> gen_mod:is_loaded(H,mod_voicehost_tenants);
is_service(_) -> false.
safe_client_packet(Packet,R) -> try client_packet(Packet,R) catch _:_ -> false end.
client_packet(#presence{type=T,from=#jid{luser=U,lserver=H},to=#jid{lresource=Nick}},_) ->
    E=entry(U,H), (T =:= available orelse T =:= unavailable) andalso Nick =:= E#voicehost_identity.extension;
client_packet(#message{type=groupchat,to=#jid{lresource= <<>>},subject=[],sub_els=Els},_) ->
    not lists:any(fun(El) ->
        lists:member(xmpp:get_ns(El),[<<"http://jabber.org/protocol/muc#user">>,
                                    <<"http://jabber.org/protocol/muc#admin">>,
                                    <<"http://jabber.org/protocol/muc#owner">>])
    end,Els);
client_packet(#iq{type=T,to=#jid{lresource= <<>>},sub_els=[El]},_) ->
    NS=xmpp:get_ns(El),
    (T =:= get andalso NS =:= <<"http://jabber.org/protocol/disco#info">>) orelse
    ((T =:= get orelse T =:= set) andalso NS =:= <<"urn:xmpp:mam:2">>);
client_packet(_,_) -> false.

list(User,Host) ->
    try entry(User,Host) of
        #voicehost_identity{account=A} ->
            Rs=mnesia:dirty_index_read(voicehost_room,A,#voicehost_room.account),
            [summary(R) || #voicehost_room{key={H,_}}=R <- Rs,H=:=Host,
                           member(jid:make(User,Host),R)]
    catch _:_ -> [] end.
summary(#voicehost_room{key={H,Room},name=N,members=M,revision=V}) ->
    Members=[begin
        E=case catch entry(U,H) of X when is_record(X,voicehost_identity) -> X;
             _ -> #voicehost_identity{extension=extension(U),name=extension(U)} end,
        {jid:encode(jid:make(U,H)),E#voicehost_identity.name,E#voicehost_identity.extension,
         atom_to_binary(Role,utf8)} end || {U,Role} <- lists:sort(maps:to_list(M))],
    {jid:encode(jid:make(Room,room_host(H))),N,V,Members}.
extension(U) -> lists:last(binary:split(U,<<"*">>,[global])).
valid_name(N) -> is_binary(N) andalso byte_size(N)>0 andalso byte_size(N)=<240 andalso
    re:run(N,<<"[\\x00-\\x1f\\x7f]">>,[{capture,none}]) =:= nomatch.

%% Serialize native MUC changes and registry revisions for one room. Publish
%% ready=false before changing native affiliations; every data path fails closed.
locked(Host,Room,Fun) ->
    try
        true=gen_mod:is_loaded(Host,mod_voicehost_tenants), true=valid_room(Room),
        global:trans({{?MODULE,Host,Room},self()},Fun)
    catch _:_ -> 1 end.
create(User,Host,Room,Name,UsersCSV) -> locked(Host,Room,fun() ->
    E=entry(User,Host), true=valid_name(Name),
    Users=lists:usort([User|binary:split(UsersCSV,<<",">>,[global])]),
    true=length(Users)>=2 andalso length(Users)=<100,
    lists:foreach(fun(U) ->
        I=entry(U,Host), true=I#voicehost_identity.account =:= E#voicehost_identity.account,
        {ok,U,_}=mod_voicehost_tenants:canonical_user(U)
    end,Users),
    Key={Host,Room},
    case mnesia:dirty_read(voicehost_room,Key) of
        [] ->
            true=length(mnesia:dirty_index_read(voicehost_room,E#voicehost_identity.account,
                         #voicehost_room.account))<256,
            M=maps:from_list([{U,case U=:=User of true -> owner; false -> member end} || U <- Users]),
            R=#voicehost_room{key=Key,account=E#voicehost_identity.account,name=Name,members=M},
            mnesia:dirty_write(R), sync_result(R);
        [#voicehost_room{members=M,closed=false}=R] ->
            %% A retry after a lost HTTP response must not reset membership.
            true=maps:get(User,M,none)=:=owner, sync_result(R);
        _ -> 1
    end
end).
manage(User,Host,Room,Action,Target,Value,Revision) -> locked(Host,Room,fun() ->
    R=read({Host,Room}), true=member(jid:make(User,Host),R),
    case Revision =:= R#voicehost_room.revision of
        false -> 3;
        true ->
            M=R#voicehost_room.members, Role=maps:get(User,M),
            New=change(Action,User,Target,Value,Role,R),
            true=New#voicehost_room.closed orelse lists:member(owner,maps:values(New#voicehost_room.members)),
            Pending=New#voicehost_room{ready=false,revision=Revision+1},
            mnesia:dirty_write(Pending), sync_result(Pending)
    end
end).
change(<<"rename">>,_,_,Name,Role,R) when Role=:=owner; Role=:=admin ->
    true=valid_name(Name), R#voicehost_room{name=Name};
change(<<"add">>,_,Target,_,Role,#voicehost_room{key={H,_},account=A,members=M}=R)
  when Role=:=owner; Role=:=admin ->
    #voicehost_identity{account=A}=entry(Target,H), {ok,Target,_}=mod_voicehost_tenants:canonical_user(Target),
    true=maps:size(M)<100 orelse maps:is_key(Target,M),
    R#voicehost_room{members=case maps:is_key(Target,M) of true -> M; false -> M#{Target=>member} end};
change(<<"remove">>,_,Target,_,Role,#voicehost_room{members=M}=R)
  when Role=:=owner; Role=:=admin ->
    TR=maps:get(Target,M), true=Role=:=owner orelse TR=:=member,
    R#voicehost_room{members=maps:remove(Target,M)};
change(<<"role">>,_,Target,V,owner,#voicehost_room{members=M,key={H,_},account=A}=R) ->
    #voicehost_identity{account=A}=entry(Target,H), true=maps:is_key(Target,M),
    NewRole=case V of <<"owner">> -> owner; <<"admin">> -> admin; <<"member">> -> member end,
    R#voicehost_room{members=M#{Target=>NewRole}};
change(<<"leave">>,User,_,_,_,#voicehost_room{members=M}=R) -> R#voicehost_room{members=maps:remove(User,M)};
change(<<"close">>,_,_,_,owner,R) -> R#voicehost_room{closed=true};
change(_,_,_,_,_,_) -> error(denied).

sync_result(R) ->
    try sync(R), mnesia:dirty_write(R#voicehost_room{ready=true}), 0
    catch _:_ -> 2 end.
sync(#voicehost_room{key={H,Room},closed=true}) ->
    case mod_muc_admin:get_room_options(Room,room_host(H)) of
        [] -> ok; _ -> ok=mod_muc_admin:destroy_room(Room,room_host(H))
    end;
sync(#voicehost_room{key={H,Room},members=M,name=N}) ->
    Service=room_host(H),
    Options=[{title,N},{persistent,true},{members_only,true},{public,false},
             {public_list,false},{anonymous,false},{mam,true},{allow_subscription,true},
             {moderated,false},{members_by_default,true},{allow_user_invites,false},
             {allow_change_subj,false},{allowpm,none},{max_users,100}],
    case mod_muc_admin:get_room_options(Room,Service) of
        [] -> ok=mod_muc:create_room(Service,Room,Options);
        _ -> lists:foreach(fun({K,V}) ->
            B=case V of true -> <<"true">>; false -> <<"false">>; 100 -> <<"100">>; none -> <<"none">>; _ -> V end,
            ok=mod_muc_admin:change_room_option(Room,Service,atom_to_binary(K,utf8),B)
        end,Options)
    end,
    lists:foreach(fun({U,Role}) ->
        ok=mod_muc_admin:set_room_affiliation(Room,Service,U,H,atom_to_binary(Role,utf8)),
        [_|_]=mod_muc_admin:subscribe_room(U,H,extension(U),Room,Service,
                                         <<"urn:xmpp:mucsub:nodes:messages">>)
    end,lists:sort(fun({_,A},{_,B}) -> A=:=owner andalso B=/=owner end,maps:to_list(M))),
    Old=mod_muc_admin:get_room_affiliations(Room,Service),
    lists:foreach(fun({U,SH,_,_}) ->
        case SH=:=H andalso maps:is_key(U,M) of
            true -> ok;
            false ->
                ok=mod_muc_admin:set_room_affiliation(Room,Service,U,SH,<<"none">>),
                ok=mod_muc_admin:unsubscribe_room(U,SH,Room,Service)
        end
    end,Old).

repair(Host) ->
    try
        Rs=mnesia:dirty_match_object(#voicehost_room{key={Host,'_'},account='_',name='_',
                         members='_',revision='_',ready=false,closed='_'}),
        lists:foreach(fun(#voicehost_room{key={_,Room}}) ->
            locked(Host,Room,fun() -> sync_result(read({Host,Room})) end)
        end,lists:sublist(Rs,25)), 0
    catch _:_ -> 1 end.
