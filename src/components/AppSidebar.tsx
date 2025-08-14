import { Phone, Users, History, Settings } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { useJanusContext } from "@/contexts/JanusContext"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

const items = [
  { title: "Dial", url: "/", icon: Phone },
  { title: "Contacts", url: "/contacts", icon: Users },
  { title: "Call History", url: "/history", icon: History },
  { title: "Settings", url: "/settings", icon: Settings },
]

export function AppSidebar() {
  const { state } = useSidebar()
  const location = useLocation()
  const currentPath = location.pathname
  const { callState } = useJanusContext()

  const isActive = (path: string) => currentPath === path
  const getNavCls = ({ isActive }: { isActive: boolean }) =>
    isActive ? "bg-accent text-accent-foreground font-medium" : "hover:bg-accent/50"

  const getConnectionStatus = () => {
    if (callState.registered && callState.status === 'connected') {
      return { text: 'Online', color: 'text-green-600' }
    }
    return { text: 'Offline', color: 'text-red-500' }
  }

  const connectionStatus = getConnectionStatus()

  return (
    <Sidebar
      collapsible="icon"
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-primary font-semibold">
            VoiceHost Phone
          </SidebarGroupLabel>

          {/* Connection Status */}
          <div className="px-2 py-2 border-b border-border">
            <div className="flex items-center gap-2 text-sm">
              <div className={`w-2 h-2 rounded-full ${callState.registered ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className={`font-medium ${connectionStatus.color}`}>
                {connectionStatus.text}
              </span>
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
    </Sidebar>
  )
}