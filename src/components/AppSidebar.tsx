import { Phone, Users, History, Settings, User, RefreshCw, Moon, Voicemail, MessageSquare, MessageCircle } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { useJanusContext } from "@/contexts/JanusContext"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar"

const items = [
  { title: "Dialpad", url: "/", icon: Phone },
  { title: "Contacts", url: "/contacts", icon: Users },
  { title: "Call History", url: "/history", icon: History },
  { title: "Voicemail", url: "/voicemail", icon: Voicemail },
  { title: "Messages", url: "/messages", icon: MessageSquare },
  { title: "SMS", url: "/sms", icon: MessageCircle },
  { title: "Settings", url: "/settings", icon: Settings },
]

export function AppSidebar() {
  const { state } = useSidebar()
  const location = useLocation()
  const currentPath = location.pathname
  const { callState, reconnect, setDoNotDisturb } = useJanusContext()

  const isActive = (path: string) => currentPath === path
  const getNavCls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "bg-accent text-accent-foreground font-medium" : "hover:bg-accent/50"

  const getConnectionStatus = () => {
    if (callState.registered && callState.status === 'connected') {
      return { text: 'Connected', color: 'text-green-600' }
    }
    return { text: 'Disconnected', color: 'text-red-500' }
  }

  const connectionStatus = getConnectionStatus()

  return (
    <Sidebar
      collapsible="icon"
    >
      <SidebarContent>
        <SidebarGroup>
          {/* Avatar at top */}
          <div className="flex justify-center py-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="bg-primary/10 text-primary">
                <User className="h-6 w-6" />
              </AvatarFallback>
            </Avatar>
          </div>

          {/* Do Not Disturb Toggle */}
          <div className="px-2 pb-4">
            <div className="flex items-center space-x-2">
              <Switch
                id="do-not-disturb"
                checked={callState.doNotDisturb}
                onCheckedChange={setDoNotDisturb}
                className="data-[state=checked]:bg-muted-foreground"
              />
              <Label htmlFor="do-not-disturb" className="text-sm font-medium cursor-pointer flex items-center gap-2">
                <Moon className="h-4 w-4" />
                {state !== "collapsed" && "Do Not Disturb"}
              </Label>
            </div>
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

      {/* Connection Status and Reconnect Button in Footer */}
      <SidebarFooter>
        <div className="px-2 py-2 space-y-2">
          {/* Connection Status */}
          <div className="flex items-center gap-2 text-sm">
            <div className={`w-2 h-2 rounded-full ${callState.registered ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={`font-medium ${connectionStatus.color}`}>
              {connectionStatus.text}
            </span>
          </div>
          
          {/* Reconnect Button */}
          {!callState.registered && (
            <Button 
              onClick={reconnect} 
              size="sm" 
              variant="outline" 
              className="w-full text-xs"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Reconnect
            </Button>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}