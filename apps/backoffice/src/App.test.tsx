import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('shows the YeaStay sign-in screen when signed out', () => {
    render(<App />);
    expect(screen.getByRole('img', { name: 'YeaStay' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
