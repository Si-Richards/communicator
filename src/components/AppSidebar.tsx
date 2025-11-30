import { Phone, Users, History, Settings, User, RefreshCw, Moon, Voicemail, MessageSquare, MessageCircle, UsersRound, Edit3, Check, X, BarChart3 } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { useJanusContext } from "@/contexts/JanusContext"
import { useXmpp } from "@/contexts/XmppContext"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PresencePicker } from "@/components/chat/PresencePicker"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { cn } from "@/lib/utils"
import { useState } from "react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"

const items = [
  { title: "Dialpad", url: "/", icon: Phone },
  { title: "Contacts", url: "/contacts", icon: Users },
  { title: "Call History", url: "/history", icon: History },
  { title: "Call Quality", url: "/call-quality", icon: BarChart3 },
  { title: "Voicemail", url: "/voicemail", icon: Voicemail },
  { title: "Chat", url: "/messages", icon: MessageSquare },
  { title: "SMS", url: "/sms", icon: MessageCircle },
  { title: "Settings", url: "/settings", icon: Settings },
]

export function AppSidebar() {
  const { state } = useSidebar()
  const location = useLocation()
  const currentPath = location.pathname
  const { callState, setDoNotDisturb } = useJanusContext()
  const { connectionState, uiConnection, userPresence, setPresence, nickname, setNickname } = useXmpp()
  
  const [isEditingNickname, setIsEditingNickname] = useState(false)
  const [tempNickname, setTempNickname] = useState('')

  const isActive = (path: string) => currentPath === path
  const getNavCls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "bg-accent text-accent-foreground font-medium" : "hover:bg-accent/50"

  const handleNicknameEdit = () => {
    setTempNickname(nickname)
    setIsEditingNickname(true)
  }

  const handleNicknameSave = () => {
    if (tempNickname.trim()) {
      setNickname(tempNickname.trim())
    }
    setIsEditingNickname(false)
  }

  const handleNicknameCancel = () => {
    setTempNickname('')
    setIsEditingNickname(false)
  }

  return (
    <TooltipProvider>
      <Sidebar
        collapsible="icon"
      >
        <SidebarContent>
          <SidebarGroup>
            {/* Avatar at top */}
            <div className="flex flex-col items-center py-4 space-y-2">
              <Avatar className="h-12 w-12">
                <AvatarFallback className="bg-primary/10 text-primary">
                  <User className="h-6 w-6" />
                </AvatarFallback>
              </Avatar>
              
              {/* Nickname editor */}
              {state === "collapsed" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleNicknameEdit}
                      className="h-6 text-xs text-muted-foreground hover:text-foreground px-1"
                    >
                      {nickname || 'Set nickname'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Click to edit nickname: {nickname}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div className="w-full px-2">
                  {isEditingNickname ? (
                    <div className="flex items-center gap-1">
                      <Input
                        value={tempNickname}
                        onChange={(e) => setTempNickname(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleNicknameSave()
                          if (e.key === 'Escape') handleNicknameCancel()
                        }}
                        className="h-6 text-xs"
                        placeholder="Nickname"
                        autoFocus
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleNicknameSave}
                        className="h-6 w-6 p-0"
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleNicknameCancel}
                        className="h-6 w-6 p-0"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleNicknameEdit}
                      className="h-6 w-full justify-between text-xs text-muted-foreground hover:text-foreground px-2"
                    >
                      <span className="truncate">{nickname || 'Set nickname'}</span>
                      <Edit3 className="h-3 w-3 ml-1 flex-shrink-0" />
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Chat Status - Always visible presence area */}
            <div className="px-2 mb-4">
              {state === "collapsed" ? (
                <div className="flex justify-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="relative">
                        {uiConnection === "connected" ? (
                          <PresencePicker
                            currentPresence={userPresence?.presence || 'available'}
                            currentStatus={userPresence?.status}
                            onPresenceChange={(presence, status) => setPresence(presence, status)}
                          />
                        ) : (
                          <StatusIndicator
                            variant={uiConnection === "reconnecting" ? "connecting" : "disconnected"}
                            label=""
                          />
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {uiConnection === "connected" ? (
                        <>
                          <p>{userPresence?.presence === 'available' ? 'Available' : 
                              userPresence?.presence === 'away' ? 'Away' :
                              userPresence?.presence === 'dnd' ? 'Do Not Disturb' :
                              userPresence?.presence === 'xa' ? 'Extended Away' : 'Offline'}</p>
                          {userPresence?.status && <p className="text-xs text-muted-foreground">{userPresence.status}</p>}
                        </>
                      ) : (
                        <p>{uiConnection === "reconnecting" ? "Reconnecting..." : "Offline"}</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  {uiConnection === "connected" ? (
                    <PresencePicker
                      currentPresence={userPresence?.presence || 'available'}
                      currentStatus={userPresence?.status}
                      onPresenceChange={(presence, status) => setPresence(presence, status)}
                    />
                  ) : (
                    <StatusIndicator
                      variant={uiConnection === "reconnecting" ? "connecting" : "disconnected"}
                      label={uiConnection === "reconnecting" ? "Reconnecting..." : "Offline"}
                    />
                  )}
                </>
              )}
            </div>


          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink to={item.url} end className={getNavCls}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Do Not Disturb Toggle in Footer */}
      <SidebarFooter>
        <div className="px-2 py-2">
          {/* Do Not Disturb Toggle */}
          {state === "collapsed" ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDoNotDisturb(!callState.doNotDisturb)}
                className={cn(
                  "h-8 w-8 p-0",
                  callState.doNotDisturb && "bg-muted text-muted-foreground"
                )}
                title={callState.doNotDisturb ? "Disable Do Not Disturb" : "Enable Do Not Disturb"}
              >
                <Moon className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center space-x-2">
              <Switch
                id="do-not-disturb"
                checked={callState.doNotDisturb}
                onCheckedChange={setDoNotDisturb}
                className="data-[state=checked]:bg-muted-foreground"
              />
              <Label htmlFor="do-not-disturb" className="text-sm font-medium cursor-pointer flex items-center gap-2">
                <Moon className="h-4 w-4" />
                Do Not Disturb
              </Label>
            </div>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
    </TooltipProvider>
  )
}