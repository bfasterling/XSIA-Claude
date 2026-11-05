import { Navigate, Route, Routes } from 'react-router-dom';
import ChatPage from './pages/chat/ChatPage';
import AdminLayout from './components/AdminLayout';
import AgentsList from './pages/agents/AgentsList';
import AgentEditor from './pages/agents/AgentEditor';
import CampaignsList from './pages/recovery/CampaignsList';
import CampaignEditor from './pages/recovery/CampaignEditor';
import Lines from './pages/system/Lines';
import Suppressions from './pages/system/Suppressions';
import Dealers from './pages/system/Dealers';
import Users from './pages/system/Users';

export default function App() {
  return (
    <Routes>
      <Route path="/c/:slug" element={<ChatPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to="agents" replace />} />
        <Route path="agents" element={<AgentsList />} />
        <Route path="agents/:id" element={<AgentEditor />} />
        <Route path="agents/:id/:tab" element={<AgentEditor />} />
        <Route path="recovery" element={<CampaignsList />} />
        <Route path="recovery/:id" element={<CampaignEditor />} />
        <Route path="recovery/:id/:tab" element={<CampaignEditor />} />
        <Route path="lines" element={<Lines />} />
        <Route path="suppressions" element={<Suppressions />} />
        <Route path="dealers" element={<Dealers />} />
        <Route path="users" element={<Users />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
