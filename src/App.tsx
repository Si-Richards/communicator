import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { JanusProvider } from "./contexts/JanusContext";
import Layout from "./components/Layout";
import Dial from "./pages/Dial";
import Contacts from "./pages/Contacts";
import History from "./pages/History";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <JanusProvider>
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<Dial />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/history" element={<History />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </JanusProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
