import { Routes, Route, Navigate } from "react-router-dom";
import { Landing } from "@/components/Landing";
import { DocsPage } from "@/components/docs/DocsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/docs/:section" element={<DocsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
