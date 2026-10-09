%% Account isolation for VoiceHost's provisioned shared SIP identities.
%% The HTTP command is restricted to the dedicated provisioning ACL.
-module(mod_voicehost_tenants).
-behaviour(gen_mod).

-include_lib("xmpp/include/xmpp.hrl").
-include("ejabberd_commands.hrl").
-include("mod_mam.hrl").

-export([start/2, stop/1, reload/3, depends/2, mod_options/1, mod_doc/0,
         filter_packet/1, user_send/1, user_receive/1, roster_get/2,
         roster_info/4, set_identity/7, valid_identity/3, contacts/2,
         migrate_history/3, canonical_user/1, push_send/2, push_events/2, ack_push/2]).

-record(voicehost_identity, {key, account, extension, address, name, enabled = false}).
-record(voicehost_history_copy, {key, last_id = 0, done = false}).
-record(voicehost_push_event, {key, host, node, jid, peer, created}).

start(_Host, _Opts) ->
    case mnesia:create_table(voicehost_identity,
                            [{disc_copies, [node()]},
                             {attributes, record_info(fields, voicehost_identity)},
                             {index, [account]}]) of
        {atomic, ok} -> ok;
        {aborted, {already_exists, voicehost_identity}} -> ok;
        Other -> error({voicehost_identity_table, Other})
    end,
    ok = mnesia:wait_for_tables([voicehost_identity], 30000),
    case mnesia:create_table(voicehost_history_copy,
                            [{disc_copies, [node()]},
                             {attributes, record_info(fields, voicehost_history_copy)}]) of
        {atomic, ok} -> ok;
        {aborted, {already_exists, voicehost_history_copy}} -> ok;
        HistoryError -> error({voicehost_history_copy_table, HistoryError})
    end,
    ok = mnesia:wait_for_tables([voicehost_history_copy], 30000),
    case mnesia:create_table(voicehost_push_event,
                            [{disc_copies, [node()]},
                             {attributes, record_info(fields, voicehost_push_event)}]) of
        {atomic, ok} -> ok;
        {aborted, {already_exists, voicehost_push_event}} -> ok;
        PushError -> error({voicehost_push_event_table, PushError})
    end,
    ok = mnesia:wait_for_tables([voicehost_push_event], 30000),
    {ok, [{hook, filter_packet, filter_packet, 10, global},
          {hook, user_send_packet, user_send, 10},
          {hook, user_receive_packet, user_receive, 10},
          {hook, roster_get, roster_get, 100},
          {hook, roster_get_jid_info, roster_info, 100},
          {hook, push_send_notification, push_send, 10},
          {commands, commands()}]}.

stop(_Host) -> ok.
reload(_Host, _NewOpts, _OldOpts) -> ok.
depends(_Host, _Opts) -> [{mod_roster, hard}, {mod_push, soft}].
mod_options(_Host) -> [].
mod_doc() -> #{desc => [<<"Account isolation and provisioned account roster for VoiceHost.">>]}.

commands() ->
    [#ejabberd_commands{name = voicehost_set_identity,
                        tags = [voicehost], version = 2,
                        desc = "Publish provisioned tenant membership and directory entry",
                        module = ?MODULE, function = set_identity,
                        args = [{user, binary}, {host, binary}, {account, binary},
                                {extension, binary}, {name, binary}, {address, binary}, {enabled, integer}],
                        result = {res, integer}},
     #ejabberd_commands{name = voicehost_migrate_history,
                        tags = [voicehost], version = 2,
                        desc = "Copy retired SIP endpoint history into its canonical messaging user",
                        module = ?MODULE, function = migrate_history,
                        args = [{old_user, binary}, {user, binary}, {host, binary}],
                        result = {res, integer}},
     #ejabberd_commands{name = voicehost_push_events, tags = [voicehost], version = 2,
                        desc = "Read pending device-bound messaging push events",
                        module = ?MODULE, function = push_events,
                        args = [{host, binary}, {limit, integer}],
                        result = {events, {list, {event, {tuple, [{id, binary}, {node, binary},
                                  {jid, binary}, {peer, binary}, {created, integer}]}}}}},
     #ejabberd_commands{name = voicehost_ack_push, tags = [voicehost], version = 2,
                        desc = "Acknowledge a durably accepted messaging push event",
                        module = ?MODULE, function = ack_push,
                        args = [{host, binary}, {id, binary}], result = {res, integer}}].

%% mod_push produces this server-originated PubSub IQ per registered device.
%% Handle only our opaque provisioning nodes; no public component or webhook.
push_send(#iq{from=#jid{luser = <<>>,lserver=Host},
              to=#jid{luser = <<>>,lserver=Host,lresource = <<>>},
              sub_els=[#pubsub{publish=#ps_publish{node=Node}}]} = IQ, Packet) ->
    case managed(Host) andalso valid_push_node(Node) of
        true -> enqueue_push(Node, Host, Packet), drop;
        false -> IQ
    end;
push_send(IQ, _) -> IQ.

valid_push_node(Node) when is_binary(Node) ->
    re:run(Node, <<"\\Avh-[a-f0-9]{64}\\z">>, [{capture,none}]) =:= match;
valid_push_node(_) -> false.

enqueue_push(Node, Host, #message{type=chat,from=From,to=To,body=Body,id=ID,sub_els=Els} = Packet) ->
    case allowed(Packet) andalso lists:any(fun(#text{data=D}) -> D =/= <<>> end,Body) andalso
         From#jid.lserver =:= Host andalso To#jid.lserver =:= Host andalso
         From#jid.luser =/= To#jid.luser of
        true ->
            %% Prefer trusted archive IDs. The client message ID also deduplicates
            %% repeated hook invocations; missing IDs get a fresh server nonce.
            SIDs = [SID || #stanza_id{id=SID,by=#jid{lserver=H}} <- Els, H =:= Host],
            Stamp = case {ID,SIDs} of {<<>>,[]} -> crypto:strong_rand_bytes(16); _ -> {ID,SIDs} end,
            Key = hex(crypto:hash(sha256,term_to_binary({Node,jid:remove_resource(From),jid:remove_resource(To),Stamp}))),
            Event = #voicehost_push_event{key=Key,host=Host,node=Node,
                        jid=jid:encode(jid:make(To#jid.luser,Host)),
                        peer=jid:encode(jid:make(From#jid.luser,Host)),created=erlang:system_time(second)},
            case mnesia:transaction(fun() ->
                mnesia:lock({table,voicehost_push_event},write),
                case mnesia:read(voicehost_push_event,Key) of
                    [] -> case mnesia:table_info(voicehost_push_event,size) < 50000 of
                              true -> mnesia:write(Event);
                              false -> mnesia:abort(push_queue_full)
                          end;
                    [_] -> ok
                end
            end) of
                {atomic,ok} -> ok;
                _ -> error_logger:warning_msg("VoiceHost push queue unavailable; message archives remain authoritative~n")
            end;
        false -> ok
    end;
enqueue_push(_, _, _) -> ok.

hex(Bytes) -> << <<(hex_digit(B bsr 4)),(hex_digit(B band 15))>> || <<B>> <= Bytes >>.
hex_digit(N) when N < 10 -> $0 + N;
hex_digit(N) -> $a + N - 10.

push_events(Host, Limit) when is_integer(Limit), Limit > 0, Limit =< 100 ->
    true = managed(Host),
    Now = erlang:system_time(second),
    {atomic, Events} = mnesia:transaction(fun() ->
        mnesia:foldl(fun(#voicehost_push_event{key=Key,host=H,created=Created}=E,Acc) ->
            case Created + 900 =< Now of
                true -> mnesia:delete({voicehost_push_event,Key}), Acc;
                false when H =:= Host -> [E|Acc];
                false -> Acc
            end
        end, [], voicehost_push_event)
    end),
    Sorted = lists:sort(fun(A,B) -> {A#voicehost_push_event.created,A#voicehost_push_event.key} <
                                  {B#voicehost_push_event.created,B#voicehost_push_event.key} end,Events),
    [{E#voicehost_push_event.key,E#voicehost_push_event.node,E#voicehost_push_event.jid,
      E#voicehost_push_event.peer,E#voicehost_push_event.created} || E <- lists:sublist(Sorted,Limit)];
push_events(_, _) -> error(invalid_push_request).

ack_push(Host, ID) ->
    case managed(Host) of
        true -> case mnesia:transaction(fun() ->
            case mnesia:read(voicehost_push_event,ID,write) of
                [] -> 0;
                [#voicehost_push_event{host=Host}] -> mnesia:delete({voicehost_push_event,ID}), 0;
                _ -> 1
            end
        end) of {atomic,Result} -> Result; _ -> 1 end;
        false -> 1
    end.

canonical_user(User) when is_binary(User), byte_size(User) =< 240 ->
    case re:run(User, <<"\\A([0-9]+)\\*([0-9]{3,5})[a-z]*\\z">>, [{capture, [1,2], binary}]) of
        {match, [Account, Extension]} -> {ok, <<Account/binary,"*",Extension/binary>>, Account};
        _ -> error
    end;
canonical_user(_) -> error.

%% Archives are copied, never removed. A durable cursor makes timeout/restart
%% retries idempotent. Only the current Mnesia backend is supported here.
migrate_history(OldUser, User, Host) ->
    case {managed(Host), canonical_user(OldUser), User =/= OldUser} of
        {true, {ok, User, Account}, true} ->
            case gen_mod:is_loaded(Host, mod_mam) andalso
                 gen_mod:db_mod(Host, mod_mam) =:= mod_mam_mnesia of
                false -> 3;
                true -> copy_history(OldUser, User, Host, Account)
            end;
        _ -> 1
    end.

copy_history(OldUser, User, Host, Account) ->
    Key = {Host, OldUser, User},
    case mnesia:transaction(fun() ->
        %% The worker proves account ownership and bans/kicks the old account
        %% before this command. Require both server-assigned registry entries.
        [#voicehost_identity{account=Account,enabled=false}] =
            mnesia:read(voicehost_identity, {Host,OldUser}),
        [#voicehost_identity{account=Account}] =
            mnesia:read(voicehost_identity, {Host,User}),
        Progress = case mnesia:read(voicehost_history_copy, Key, write) of
            [] -> #voicehost_history_copy{key=Key};
            [P] -> P
        end,
        case Progress#voicehost_history_copy.done of
            true -> 0;
            false ->
                Source = mnesia:read(archive_msg, {OldUser,Host}),
                Pending = lists:sort(fun(A,B) -> binary_to_integer(A#archive_msg.id) < binary_to_integer(B#archive_msg.id) end,
                                    [M || M <- Source, binary_to_integer(M#archive_msg.id) > Progress#voicehost_history_copy.last_id]),
                Boundary = case length(Pending) > 500 of
                    true -> binary_to_integer((lists:nth(500, Pending))#archive_msg.id);
                    false -> infinity
                end,
                Batch = [M || M <- Pending, Boundary =:= infinity orelse binary_to_integer(M#archive_msg.id) =< Boundary],
                Target = mnesia:read(archive_msg, {User,Host}, write),
                lists:foldl(fun(M, Existing) -> copy_message(M, User, Host, Account, Existing) end, Target, Batch),
                Last = case Batch of [] -> Progress#voicehost_history_copy.last_id; _ -> binary_to_integer((lists:last(Batch))#archive_msg.id) end,
                Done = Boundary =:= infinity,
                mnesia:write(Progress#voicehost_history_copy{last_id=Last,done=Done}),
                case Done of true -> 0; false -> 2 end
        end
    end) of
        {atomic, Result} -> Result;
        _ -> 1
    end.

copy_message(#archive_msg{type=chat,peer={Peer,Host,Resource}} = Msg, User, Host, Account, Existing) ->
    case canonical_user(Peer) of
        {ok, CanonicalPeer, Account} ->
            Packet = case Msg#archive_msg.packet of
                #xmlel{} = Xml -> Xml;
                Stanza -> xmpp:encode(Stanza)
            end,
            Copy = Msg#archive_msg{us={User,Host},peer={CanonicalPeer,Host,Resource},
                                   bare_peer={CanonicalPeer,Host,<<>>},
                                   packet=rewrite_archive_xml(Packet, Host, Account)},
            case [M || M <- Existing, M#archive_msg.id =:= Copy#archive_msg.id] of
                [] -> mnesia:write(Copy), [Copy|Existing];
                [Copy] -> Existing;
                _ -> mnesia:abort(archive_id_collision)
            end;
        _ -> Existing
    end;
copy_message(_, _, _, _, Existing) -> Existing.

rewrite_archive_xml(#xmlel{name=Name,attrs=Attrs,children=Children} = Xml, Host, Account) ->
    NewAttrs = [{K, case {Name,K} of
                       {<<"message">>,<<"from">>} -> rewrite_archive_jid(V,Host,Account);
                       {<<"message">>,<<"to">>} -> rewrite_archive_jid(V,Host,Account);
                       {<<"stanza-id">>,<<"by">>} -> rewrite_archive_jid(V,Host,Account);
                       _ -> V
                   end} || {K,V} <- Attrs],
    Xml#xmlel{attrs=NewAttrs,children=[rewrite_archive_xml(C,Host,Account) || C <- Children]};
rewrite_archive_xml(Other, _, _) -> Other.

rewrite_archive_jid(Value, Host, Account) ->
    try jid:decode(Value) of
        #jid{luser=U,lserver=Host,lresource=Resource} ->
            case canonical_user(U) of
                {ok, Canonical, Account} -> jid:encode(jid:make(Canonical,Host,Resource));
                _ -> Value
            end;
        _ -> Value
    catch _:_ -> Value
    end.

%% No client stanza can assign account membership. A malformed or mismatched
%% account/extension never gets a registry entry, including on manual imports.
set_identity(User, Host, Account, Extension, Name, Address, Enabled)
  when is_binary(Name), byte_size(Name) =< 480,
       is_binary(Address), byte_size(Address) =< 80,
       (Enabled =:= 0 orelse Enabled =:= 1) ->
    case managed(Host) andalso valid_identity(User, Account, Extension) andalso segment(Address) of
        true ->
            Entry = #voicehost_identity{key = {Host, User}, account = Account,
                                       extension = Extension, address = Address, name = Name,
                                       enabled = Enabled =:= 1},
            case mnesia:transaction(fun() ->
                mnesia:lock({table, voicehost_identity}, write),
                Others = mnesia:index_read(voicehost_identity, Account, #voicehost_identity.account),
                Conflict = Enabled =:= 1 andalso lists:any(
                  fun(#voicehost_identity{key = {H,U}, address = A, enabled = E}) ->
                      H =:= Host andalso U =/= User andalso A =:= Address andalso E
                  end, Others),
                case Conflict of
                    true -> mnesia:abort(ambiguous_extension);
                    false -> mnesia:write(Entry)
                end
            end) of
                {atomic, ok} -> 0;
                _ -> 1
            end;
        false -> 1
    end;
set_identity(_, _, _, _, _, _, _) -> 1.

valid_identity(User, Account, Extension)
  when is_binary(User), is_binary(Account), is_binary(Extension), byte_size(User) =< 240 ->
    User =:= <<Account/binary, "*", Extension/binary>>
    andalso segment(Account) andalso segment(Extension);
valid_identity(_, _, _) -> false.

segment(Value) ->
    re:run(Value, <<"\\A[a-z0-9._+\\-]+\\z">>, [{capture, none}]) =:= match.

managed(Host) -> gen_mod:is_loaded(Host, ?MODULE).

identity(#jid{luser = User, lserver = Host}) ->
    try mnesia:dirty_read(voicehost_identity, {Host, User}) of
        [#voicehost_identity{enabled = true} = Entry] -> {ok, Entry};
        _ -> denied
    catch _:_ -> denied
    end;
identity(_) -> denied.

%% Unknown identities, service subdomains, remote servers and cross-account
%% peers are denied. Self MAM/private storage and server replies remain usable.
allowed(Packet) ->
    From = xmpp:get_from(Packet),
    To = xmpp:get_to(Packet),
    case {From, To} of
        {#jid{lserver = FH}, #jid{lserver = TH}} ->
            case managed(FH) orelse managed(TH) of
                false -> true;
                true -> allowed_local(Packet, From, To)
            end;
        _ -> false
    end.

allowed_local(Packet, #jid{luser = FU, lserver = Host} = From,
                     #jid{luser = TU, lserver = Host} = To) ->
    case {FU, TU} of
        {<<>>, <<>>} -> true;
        {<<>>, _} -> identity(To) =/= denied;
        {_, <<>>} -> identity(From) =/= denied andalso server_query(Packet);
        _ ->
            case {identity(From), identity(To)} of
                {{ok, #voicehost_identity{account = Account}},
                 {ok, #voicehost_identity{account = Account}}} ->
                    not readonly_roster_set(Packet);
                _ -> false
            end
    end;
allowed_local(_, _, _) -> false.

server_query(#iq{type = Type, sub_els = Els}) when Type =:= get; Type =:= set ->
    case Els of
        [El] ->
            lists:member(xmpp:get_ns(El),
                         [<<"urn:xmpp:ping">>, <<"http://jabber.org/protocol/disco#info">>,
                          <<"jabber:iq:roster">>, <<"jabber:iq:private">>,
                          <<"urn:xmpp:mam:2">>, <<"urn:xmpp:carbons:2">>,
                          <<"urn:xmpp:blocking">>, <<"jabber:iq:privacy">>,
                          <<"urn:ietf:params:xml:ns:xmpp-session">>])
            andalso not readonly_roster_set(#iq{type = Type, sub_els = Els});
        _ -> false
    end;
server_query(#iq{type = Type}) when Type =:= result; Type =:= error -> true;
server_query(_) -> false.

readonly_roster_set(#iq{type = set, sub_els = [El]}) ->
    xmpp:get_ns(El) =:= <<"jabber:iq:roster">>;
readonly_roster_set(_) -> false.

filter_packet(drop) -> drop;
filter_packet(Packet) ->
    case allowed(Packet) of
        true -> Packet;
        false ->
            %% Silent denial avoids username/account existence disclosure.
            %% The phone validates recipients before sending; raw XMPP clients
            %% receive no probe response for any forbidden destination.
            drop
    end.

user_send({drop, _} = Acc) -> Acc;
user_send({Packet, State} = Acc) ->
    %% Undirected initial presence and bind/session IQs are handled by c2s
    %% before routing. Validate the authenticated identity using its session,
    %% rather than a client-controlled from attribute.
    JID = maps:get(jid, State, undefined),
    From = xmpp:get_from(Packet),
    case same_identity(JID, From) andalso identity(JID) =/= denied of
        false -> {stop, {drop, State}};
        true ->
            case xmpp:get_to(Packet) of
                undefined ->
                    case Packet of
                        #presence{} -> Acc;
                        #iq{} ->
                            case server_query(Packet) of
                                true -> Acc;
                                false -> {stop, {drop, State}}
                            end;
                        _ -> {stop, {drop, State}}
                    end;
                _ ->
                    case allowed(Packet) of
                        true -> Acc;
                        false -> {stop, {drop, State}}
                    end
            end
    end.

same_identity(#jid{luser = U, lserver = H}, #jid{luser = U, lserver = H}) -> true;
same_identity(_, _) -> false.

user_receive({drop, _} = Acc) -> Acc;
user_receive({Packet, State} = Acc) ->
    %% Re-check old offline messages at delivery after a lock or migration.
    case allowed(Packet) of
        true -> Acc;
        false -> {stop, {drop, State}}
    end.

contacts(User, Host) ->
    case identity(jid:make(User, Host)) of
        {ok, #voicehost_identity{account = Account}} ->
            try mnesia:dirty_index_read(voicehost_identity, Account, #voicehost_identity.account) of
                Entries ->
                    lists:sort(fun(A, B) -> A#voicehost_identity.extension < B#voicehost_identity.extension end,
                               [E || #voicehost_identity{key = {H, U}, enabled = true} = E <- Entries,
                                     H =:= Host, U =/= User])
            catch _:_ -> []
            end;
        _ -> []
    end.

roster_get(_StoredRoster, {User, Host}) ->
    %% A read-only shared roster, authoritative even if an old personal roster
    %% contains another tenant's JID. Each shared identity appears only once.
    %% ejabberd passes {User, Host} as one hook argument and consumes XMPP
    %% roster_item records both for IQ results and for presence broadcasts.
    [#roster_item{jid = jid:make(U, Host), name = Name, subscription = both,
                  groups = [<<"Account users">>, <<"VoiceHost extension:", Address/binary>>]}
     || #voicehost_identity{key = {_, U}, name = Name, address = Address} <- contacts(User, Host)].

roster_info(_Acc, User, Host, JID) ->
    Packet = #presence{from = jid:make(User, Host), to = JID},
    case allowed(Packet) of
        true -> {both, none, [<<"Account users">>]};
        false -> {none, none, []}
    end.
