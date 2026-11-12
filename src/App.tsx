import { useEffect } from 'react';
import { useApp } from './state/app';
import { Home } from './components/Home';
import { Editor } from './components/editor/Editor';
import { FilePickers } from './components/files';

export default function App() {
  const view = useApp((s) => s.view);

  useEffect(() => {
    // No page zoom: pinch gestures belong to the preview and the timeline.
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', prevent);
    document.addEventListener('gesturechange', prevent);
    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
    };
  }, []);

  return (
    <>
      {view === 'home' ? <Home /> : <Editor />}
      <FilePickers />
    </>
  );
}
