import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useRetentionDesk, useRetentionDeskControls } from '../src/retention-desk-state.ts';

export function mountRetentionStateFixture() {
  const container = document.createElement('div');
  document.body.append(container);
  window.__retentionStateFixture = {};
  window.confirm = () => true;

  function Desk({ controls }) {
    const desk = useRetentionDesk({
      refreshToken: controls.refreshToken,
      onSnapshot: controls.onSnapshot,
      onBusyChange: controls.onBusyChange,
    });
    window.__retentionStateFixture.desk = desk;
    return React.createElement('output', { id: 'retention-fixture-preview' }, desk.previewNotice);
  }

  function Parent() {
    const controls = useRetentionDeskControls();
    const [visible, setVisible] = useState(true);
    window.__retentionStateFixture.controls = controls;
    window.__retentionStateFixture.setVisible = setVisible;
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'output',
        { id: 'retention-fixture-busy' },
        controls.busy ? 'busy' : 'idle',
      ),
      visible ? React.createElement(Desk, { controls }) : null,
    );
  }

  createRoot(container).render(React.createElement(Parent));
}
