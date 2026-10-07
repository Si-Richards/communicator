%% Account isolation for VoiceHost's provisioned shared SIP identities.
%% The HTTP command is restricted to the dedicated provisioning ACL.
-module(mod_voicehost_tenants).
-behaviour(gen_mod).

-include_lib("xmpp/include/xmpp.hrl").
-include("ejabberd_commands.hrl").
-include("mod_roster.hrl").

-export([start/2, stop/1, reload/3, depends/2, mod_options/1, mod_doc/0,
         filter_packet/1, user_send/1, user_receive/1, roster_get/3,
         roster_info/4, set_identity/7, valid_identity/3, contacts/2]).

-record(voicehost_identity, {key, account, extension, address, name, enabled = false}).

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
    {ok, [{hook, filter_packet, filter_packet, 10, global},
          {hook, user_send_packet, user_send, 10},
          {hook, user_receive_packet, user_receive, 10},
          {hook, roster_get, roster_get, 100},
          {hook, roster_get_jid_info, roster_info, 100},
          {commands, commands()}]}.

stop(_Host) -> ok.
reload(_Host, _NewOpts, _OldOpts) -> ok.
depends(_Host, _Opts) -> [{mod_roster, hard}].
mod_options(_Host) -> [].
mod_doc() -> #{desc => [<<"Account isolation and provisioned account roster for VoiceHost.">>]}.

commands() ->
    [#ejabberd_commands{name = voicehost_set_identity,
                        tags = [voicehost], version = 2,
                        desc = "Publish provisioned tenant membership and directory entry",
                        module = ?MODULE, function = set_identity,
                        args = [{user, binary}, {host, binary}, {account, binary},
                                {extension, binary}, {name, binary}, {address, binary}, {enabled, integer}],
                        result = {res, integer}}].

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

roster_get(_StoredRoster, User, Host) ->
    %% A read-only shared roster, authoritative even if an old personal roster
    %% contains another tenant's JID. Each shared identity appears only once.
    [#roster{usj = {User, Host, {U, Host, <<>>}}, us = {User, Host},
             jid = {U, Host, <<>>}, name = Name, subscription = both,
             groups = [<<"Account users">>, <<"VoiceHost extension:", Address/binary>>]}
     || #voicehost_identity{key = {_, U}, name = Name, address = Address} <- contacts(User, Host)].

roster_info(_Acc, User, Host, JID) ->
    Packet = #presence{from = jid:make(User, Host), to = JID},
    case allowed(Packet) of
        true -> {both, none, [<<"Account users">>]};
        false -> {none, none, []}
    end.
