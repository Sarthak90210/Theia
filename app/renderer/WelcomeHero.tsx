import FluidGlass from './glass/FluidGlass.jsx'
import GlassIcons from './glass/GlassIcons.jsx'
import * as I from './icons.tsx'

/**
 * What the window shows before any vault is open: the headline under a drop
 * of liquid glass that follows the pointer (React Bits FluidGlass), and the
 * first things to do as glass icons (React Bits GlassIcons).
 *
 * Without Liquid Glass (switched off, or Windows asking for less
 * transparency) the headline is plain text and the icons are clear glass.
 */
export function WelcomeHero({ liquid, dark, onOpenVault, onSettings, onShortcuts, onPhone }: {
  liquid: boolean
  dark: boolean
  onOpenVault: () => void
  onSettings: () => void
  onShortcuts: () => void
  onPhone: () => void
}) {
  const items = [
    { icon: <I.Vault size={30} />, color: 'blue', label: 'Open a vault', onClick: onOpenVault },
    { icon: <I.Phone size={30} />, color: 'green', label: 'Connect an iPhone', onClick: onPhone },
    { icon: <I.Sliders size={30} />, color: 'purple', label: 'Settings', onClick: onSettings },
    { icon: <I.Info size={30} />, color: 'orange', label: 'Shortcuts', onClick: onShortcuts },
  ]
  return (
    <div className="welcome-hero">
      <div className="welcome-hero-glass">
        {liquid ? (
          <FluidGlass
            text={'Your photos,\nat home.'}
            shape="lens"
            size={230}
            interaction="follow"
            refraction={1}
            dispersion={0.3}
            reflection={0.9}
            shadow={0.35}
            fontWeight={700}
            textColor={dark ? '#f2f2f5' : '#1d1d1f'}
            morphOnClick
            shapes={['lens', 'blob', 'pill', 'torus']}
          />
        ) : (
          <h2 className="welcome-hero-title">Your photos,<br />at home.</h2>
        )}
      </div>
      <p className="muted welcome-hero-note">Open a vault to browse your library, or connect an iPhone to start bringing your photos together.</p>
      <GlassIcons
        items={items}
        size={76}
        gap={44}
        columns={4}
        labels="always"
        refraction={liquid ? 0.8 : 0}
        frost={liquid ? 0.2 : 0.6}
        theme={dark ? 'dark' : 'light'}
        plate="tilt"
        hover="press"
      />
    </div>
  )
}
