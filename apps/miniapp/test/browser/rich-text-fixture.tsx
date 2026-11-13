import '../../src/styles.css';
import '../../src/styles/publications-page.css';
import '../../src/styles/publisher-workspace.css';
import '../../src/features/publications/publication-workbench.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MaxRichTextEditor } from '../../src/components/max-rich-text-editor';
import { MaxMarkdownPreview } from '../../src/components/max-markdown-preview';
import { BroadcastContentComposer } from '../../src/components/broadcast-content-composer';

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [value, setValue] = useState(params.get('value') ?? '');
  return (
    <main
      className={params.has('composer') ? 'publications-page is-publisher is-editor' : undefined}
      style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}
    >
      {params.has('composer') ? (
        <BroadcastContentComposer
          className="publication-content-composer"
          text={value}
          onTextChange={setValue}
          maxLength={4000}
          textAriaLabel="Greeting"
          allowImages={false}
        />
      ) : (
        <MaxRichTextEditor
          value={value}
          onChange={setValue}
          maxLength={4000}
          placeholder="Greeting"
          ariaLabel="Greeting"
          preserveWhitespace={params.has('preserve')}
        />
      )}
      <MaxMarkdownPreview value={value} preserveLinks />
      <output data-testid="markdown" style={{ display: 'none' }}>
        {value}
      </output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
