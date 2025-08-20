import { Phone, Users, History, Settings, User, RefreshCw, Moon, Voicemail, MessageSquare, MessageCircle, UsersRound } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { useJanusContext } from "@/contexts/JanusContext"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

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

  const isActive = (path: string) => currentPath === path
  const getNavCls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "bg-accent text-accent-foreground font-medium" : "hover:bg-accent/50"

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
  )
}