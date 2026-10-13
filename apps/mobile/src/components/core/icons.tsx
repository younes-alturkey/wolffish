import { cssInterop } from 'nativewind'
import Svg, { Circle, Ellipse, Path, Rect, type SvgProps } from 'react-native-svg'

// Let icons take Tailwind text color classes (className="text-muted") the
// same way hugeicons-react icons inherit currentColor on the desktop app.
cssInterop(Svg, {
  className: {
    target: 'style',
    nativeStyleToProp: { color: true }
  }
})

export type IconProps = Pick<SvgProps, 'color'> & {
  size?: number
  className?: string
}

type IconBaseProps = IconProps & { children: React.ReactNode }

export function IconBase({
  size = 24,
  color,
  className,
  children
}: IconBaseProps): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      color={color}
      className={className}
    >
      {children}
    </Svg>
  )
}

// Path data is taken verbatim from the Hugeicons free core set (CC0) — the
// exact icons wolffish-app renders through hugeicons-react.

export function ArrowDown01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Tick02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M5 14L8.5 17.5L19 6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CheckmarkCircle02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M8 12.5L10.5 15L16 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Alert02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 9V13.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 16.9922V17.0022"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </IconBase>
  )
}

export function InformationCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle
        cx={12}
        cy={12}
        r={10}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 16V11.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 8.01172V8.00172"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </IconBase>
  )
}

export function Cancel01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ComputerIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14 21H16M14 21C13.1716 21 12.5 20.3284 12.5 19.5V17L12 17M14 21H10M10 21H8M10 21C10.8284 21 11.5 20.3284 11.5 19.5V17L12 17M12 17V21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 3H8C5.17157 3 3.75736 3 2.87868 3.87868C2 4.75736 2 6.17157 2 9V11C2 13.8284 2 15.2426 2.87868 16.1213C3.75736 17 5.17157 17 8 17H16C18.8284 17 20.2426 17 21.1213 16.1213C22 15.2426 22 13.8284 22 11V9C22 6.17157 22 4.75736 21.1213 3.87868C20.2426 3 18.8284 3 16 3Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

/** The terminal — the CLI channel's glyph, matching the desktop's own. */
export function ComputerTerminal01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7 7L8.22654 8.05719C8.74218 8.50163 9 8.72386 9 9C9 9.27614 8.74218 9.49836 8.22654 9.94281L7 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11 11H14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 21C15.7497 21 17.6246 21 18.9389 20.0451C19.3634 19.7367 19.7367 19.3634 20.0451 18.9389C21 17.6246 21 15.7497 21 12C21 8.25027 21 6.3754 20.0451 5.06107C19.7367 4.6366 19.3634 4.26331 18.9389 3.95491C17.6246 3 15.7497 3 12 3C8.25027 3 6.3754 3 5.06107 3.95491C4.6366 4.26331 4.26331 4.6366 3.95491 5.06107C3 6.3754 3 8.25027 3 12C3 15.7497 3 17.6246 3.95491 18.9389C4.26331 19.3634 4.6366 19.7367 5.06107 20.0451C6.3754 21 8.25027 21 12 21Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CloudIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17.4776 10.0001C17.485 10 17.4925 10 17.5 10C19.9853 10 22 12.0147 22 14.5C22 16.9853 19.9853 19 17.5 19H7C4.23858 19 2 16.7614 2 14C2 11.4003 3.98398 9.26407 6.52042 9.0227M17.4776 10.0001C17.4924 9.83536 17.5 9.66856 17.5 9.5C17.5 6.46243 15.0376 4 12 4C9.12324 4 6.76233 6.20862 6.52042 9.0227M17.4776 10.0001C17.3753 11.1345 16.9286 12.1696 16.2428 13M6.52042 9.0227C6.67826 9.00768 6.83823 9 7 9C8.12582 9 9.16474 9.37209 10.0005 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Moon02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M21.5 14.0784C20.3003 14.7189 18.9301 15.0821 17.4751 15.0821C12.7491 15.0821 8.91792 11.2509 8.91792 6.52485C8.91792 5.06986 9.28105 3.69968 9.92163 2.5C5.66765 3.49698 2.5 7.31513 2.5 11.8731C2.5 17.1899 6.8101 21.5 12.1269 21.5C16.6849 21.5 20.503 18.3324 21.5 14.0784Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Sun03Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17 12C17 14.7614 14.7614 17 12 17C9.23858 17 7 14.7614 7 12C7 9.23858 9.23858 7 12 7C14.7614 7 17 9.23858 17 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M12 2V3.5M12 20.5V22M19.0708 19.0713L18.0101 18.0106M5.98926 5.98926L4.9286 4.9286M22 12H20.5M3.5 12H2M19.0713 4.92871L18.0106 5.98937M5.98975 18.0107L4.92909 19.0714"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function EyeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2 8C2 8 6.47715 3 12 3C17.5228 3 22 8 22 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21.544 13.045C21.848 13.4713 22 13.6845 22 14C22 14.3155 21.848 14.5287 21.544 14.955C20.1779 16.8706 16.6892 21 12 21C7.31078 21 3.8221 16.8706 2.45604 14.955C2.15201 14.5287 2 14.3155 2 14C2 13.6845 2.15201 13.4713 2.45604 13.045C3.8221 11.1294 7.31078 7 12 7C16.6892 7 20.1779 11.1294 21.544 13.045Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M15 14C15 12.3431 13.6569 11 12 11C10.3431 11 9 12.3431 9 14C9 15.6569 10.3431 17 12 17C13.6569 17 15 15.6569 15 14Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ViewOffIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 8C22 8 18 14 12 14C6 14 2 8 2 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M15 13.5L16.5 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20 11L22 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2 13L4 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9 13.5L7.5 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ArrowUp02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12 5.5V19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Mic01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17 7V11C17 13.7614 14.7614 16 12 16C9.23858 16 7 13.7614 7 11V7C7 4.23858 9.23858 2 12 2C14.7614 2 17 4.23858 17 7Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M17 7H14M17 11H14" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path
        d="M20 11C20 15.4183 16.4183 19 12 19M12 19C7.58172 19 4 15.4183 4 11M12 19V22M12 22H15M12 22H9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function StopCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M9.38886 15.1629C9.89331 15.5 10.5955 15.5 12 15.5C13.4045 15.5 14.1067 15.5 14.6111 15.1629C14.8295 15.017 15.017 14.8295 15.1629 14.6111C15.5 14.1067 15.5 13.4045 15.5 12C15.5 10.5955 15.5 9.89331 15.1629 9.38886C15.017 9.17048 14.8295 8.98298 14.6111 8.83706C14.1067 8.5 13.4045 8.5 12 8.5C10.5955 8.5 9.89331 8.5 9.38886 8.83706C9.17048 8.98298 8.98298 9.17048 8.83706 9.38886C8.5 9.89331 8.5 10.5955 8.5 12C8.5 13.4045 8.5 14.1067 8.83706 14.6111C8.98298 14.8295 9.17048 15.017 9.38886 15.1629Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PlusSignIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12 4V20M20 12H4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Copy01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Delete01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Delete02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path d="M9.5 16.5L9.5 10.5" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path
        d="M14.5 16.5L14.5 10.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ArrowLeft01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ArrowRight01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Clock01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M12 8V12L14 14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function BubbleChatIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12.0045 12H12.0135M16 12H16.009M8.009 12H8.01797"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function WorkflowSquare03Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3 4C3 2.34533 3.34533 2 5 2H9C10.6547 2 11 2.34533 11 4C11 5.65467 10.6547 6 9 6H5C3.34533 6 3 5.65467 3 4Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M13 13C13 11.3453 13.3453 11 15 11H19C20.6547 11 21 11.3453 21 13C21 14.6547 20.6547 15 19 15H15C13.3453 15 13 14.6547 13 13Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M4 20C4 18.3453 4.34533 18 6 18H10C11.6547 18 12 18.3453 12 20C12 21.6547 11.6547 22 10 22H6C4.34533 22 4 21.6547 4 20Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M17 11C17 10.5353 17 10.303 16.9616 10.1098C16.8038 9.31644 16.1836 8.69624 15.3902 8.53843C15.197 8.5 14.9647 8.5 14.5 8.5H9.5C9.03534 8.5 8.80302 8.5 8.60982 8.46157C7.81644 8.30376 7.19624 7.68356 7.03843 6.89018C7 6.69698 7 6.46466 7 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17 15V16C17 17.8856 17 18.8284 16.4142 19.4142C15.8284 20 14.8856 20 13 20H12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function File01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M8 7L16 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8 11L12 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 21.5V21C13 18.1716 13 16.7574 13.8787 15.8787C14.7574 15 16.1716 15 19 15H19.5M20 13.3431V10C20 6.22876 20 4.34315 18.8284 3.17157C17.6569 2 15.7712 2 12 2C8.22877 2 6.34315 2 5.17157 3.17157C4 4.34314 4 6.22876 4 10L4 14.5442C4 17.7892 4 19.4117 4.88607 20.5107C5.06508 20.7327 5.26731 20.9349 5.48933 21.1139C6.58831 22 8.21082 22 11.4558 22C12.1614 22 12.5141 22 12.8372 21.886C12.9044 21.8623 12.9702 21.835 13.0345 21.8043C13.3436 21.6564 13.593 21.407 14.0919 20.9081L18.8284 16.1716C19.4065 15.5935 19.6955 15.3045 19.8478 14.9369C20 14.5694 20 14.1606 20 13.3431Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Image02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3 16L7.46967 11.5303C7.80923 11.1908 8.26978 11 8.75 11C9.23022 11 9.69077 11.1908 10.0303 11.5303L14 15.5M15.5 17L14 15.5M21 16L18.5303 13.5303C18.1908 13.1908 17.7302 13 17.25 13C16.7698 13 16.3092 13.1908 15.9697 13.5303L14 15.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M15.5 8C15.7761 8 16 7.77614 16 7.5C16 7.22386 15.7761 7 15.5 7M15.5 8C15.2239 8 15 7.77614 15 7.5C15 7.22386 15.2239 7 15.5 7M15.5 8V7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3.69797 19.7472C2.5 18.3446 2.5 16.2297 2.5 12C2.5 7.77027 2.5 5.6554 3.69797 4.25276C3.86808 4.05358 4.05358 3.86808 4.25276 3.69797C5.6554 2.5 7.77027 2.5 12 2.5C16.2297 2.5 18.3446 2.5 19.7472 3.69797C19.9464 3.86808 20.1319 4.05358 20.302 4.25276C21.5 5.6554 21.5 7.77027 21.5 12C21.5 16.2297 21.5 18.3446 20.302 19.7472C20.1319 19.9464 19.9464 20.1319 19.7472 20.302C18.3446 21.5 16.2297 21.5 12 21.5C7.77027 21.5 5.6554 21.5 4.25276 20.302C4.05358 20.1319 3.86808 19.9464 3.69797 19.7472Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M18.8906 12.846C18.5371 14.189 16.8667 15.138 13.5257 17.0361C10.296 18.8709 8.6812 19.7884 7.37983 19.4196C6.8418 19.2671 6.35159 18.9776 5.95624 18.5787C5 17.6139 5 15.7426 5 12C5 8.2574 5 6.3861 5.95624 5.42132C6.35159 5.02245 6.8418 4.73288 7.37983 4.58042C8.6812 4.21165 10.296 5.12907 13.5257 6.96393C16.8667 8.86197 18.5371 9.811 18.8906 11.154C19.0365 11.7084 19.0365 12.2916 18.8906 12.846Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PauseIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 7C4 5.58579 4 4.87868 4.43934 4.43934C4.87868 4 5.58579 4 7 4C8.41421 4 9.12132 4 9.56066 4.43934C10 4.87868 10 5.58579 10 7V17C10 18.4142 10 19.1213 9.56066 19.5607C9.12132 20 8.41421 20 7 20C5.58579 20 4.87868 20 4.43934 19.5607C4 19.1213 4 18.4142 4 17V7Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M14 7C14 5.58579 14 4.87868 14.4393 4.43934C14.8787 4 15.5858 4 17 4C18.4142 4 19.1213 4 19.5607 4.43934C20 4.87868 20 5.58579 20 7V17C20 18.4142 20 19.1213 19.5607 19.5607C19.1213 20 18.4142 20 17 20C15.5858 20 14.8787 20 14.4393 19.5607C14 19.1213 14 18.4142 14 17V7Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Download01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function FlashIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function BrainIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M16.998 7.12652C17.3182 7.04393 17.654 7 18 7C20.2091 7 22 8.79086 22 11C22 13.2091 20.2091 15 18 15C17.6451 15 17.3009 14.9538 16.9733 14.867M16.998 7.12652C16.9993 7.08451 17 7.04233 17 7C17 4.79086 15.2091 3 13 3C11.0824 3 9.47994 4.34939 9.09041 6.15043M16.998 7.12652C16.9769 7.80763 16.7854 8.44584 16.4649 9M16.9733 14.867C16.9909 14.7472 17 14.6247 17 14.5C17 13.2905 16.1411 12.2816 15 12.05M16.9733 14.867C16.7957 16.0737 15.756 17 14.5 17H14C11.7909 17 10 18.7909 10 21M9.09041 6.15043C8.74377 6.05243 8.37801 6 8 6C5.79086 6 4 7.79086 4 10C4 10.3886 4.05542 10.7643 4.15878 11.1195M9.09041 6.15043C10.1015 6.43625 10.9498 7.10965 11.4649 8M4.15878 11.1195C2.9114 11.4832 2 12.6352 2 14C2 15.6569 3.34315 17 5 17C6.30622 17 7.41746 16.1652 7.82929 15M4.15878 11.1195C4.24921 11.4303 4.37632 11.7255 4.53513 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.8361 11.7435C11.3257 12.2353 10.453 12.3202 9.70713 11.9008C8.9612 11.4814 8.58031 10.6917 8.73535 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function AiBrain01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7 4.5C5.34315 4.5 4 5.84315 4 7.5C4 8.06866 4.15822 8.60037 4.43304 9.0535C3.04727 9.31855 2 10.537 2 12C2 13.463 3.04727 14.6814 4.43304 14.9465M7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V19.5C12 20.8807 10.8807 22 9.5 22C8.11929 22 7 20.8807 7 19.5C5.34315 19.5 4 18.1569 4 16.5C4 15.9313 4.15822 15.3996 4.43304 14.9465M7 4.5C7 5.31791 7.39278 6.04408 8 6.50018M4.43304 14.9465C4.78948 14.3588 5.34207 13.9032 6 13.6707"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17 19.4999C18.6569 19.4999 20 18.1567 20 16.4999C20 15.9312 19.8418 15.3995 19.567 14.9464C20.9527 14.6813 22 13.4629 22 11.9999C22 10.5369 20.9527 9.31843 19.567 9.05338M17 19.4999C17 20.8806 15.8807 21.9999 14.5 21.9999C13.1193 21.9999 12 20.8806 12 19.4999L12 4.49988C12 3.11917 13.1193 1.99988 14.5 1.99988C15.8807 1.99988 17 3.11917 17 4.49988C18.6569 4.49988 20 5.84302 20 7.49988C20 8.06854 19.8418 8.60024 19.567 9.05338M17 19.4999C17 18.682 16.6072 17.9558 16 17.4997M19.567 9.05338C19.2105 9.64109 18.6579 10.0966 18 10.3292"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function FireIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M13.8561 22C26.0783 19 19.2338 7 10.9227 2C9.9453 5.5 8.47838 6.5 5.54497 10C1.66121 14.6339 3.5895 20 8.96719 22C8.1524 21 6.04958 18.9008 7.5 16C8 15 9 14 8.5 12C9.47778 12.5 11.5 13 12 15.5C12.8148 14.5 13.6604 12.4 12.8783 10C19 14.5 16.5 19 13.8561 22Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Activity04Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M21.5 4.5C21.5 5.60457 20.6046 6.5 19.5 6.5C18.3954 6.5 17.5 5.60457 17.5 4.5C17.5 3.39543 18.3954 2.5 19.5 2.5C20.6046 2.5 21.5 3.39543 21.5 4.5Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M20.4711 9.40577C20.5 10.2901 20.5 11.3119 20.5 12.5C20.5 16.7426 20.5 18.864 19.182 20.182C17.864 21.5 15.7426 21.5 11.5 21.5C7.25736 21.5 5.13604 21.5 3.81802 20.182C2.5 18.864 2.5 16.7426 2.5 12.5C2.5 8.25736 2.5 6.13604 3.81802 4.81802C5.13604 3.5 7.25736 3.5 11.5 3.5C12.6881 3.5 13.7099 3.5 14.5942 3.52895"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M5.5 12.5H8L10 8.5L13 16.5L15 12.5H17.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CancelCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14.9994 15L9 9M9.00064 15L15 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Settings02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M21.011 14.0965C21.5329 13.9558 21.7939 13.8854 21.8969 13.7508C22 13.6163 22 13.3998 22 12.9669V11.0332C22 10.6003 22 10.3838 21.8969 10.2493C21.7938 10.1147 21.5329 10.0443 21.011 9.90358C19.0606 9.37759 17.8399 7.33851 18.3433 5.40087C18.4817 4.86799 18.5509 4.60156 18.4848 4.44529C18.4187 4.28902 18.2291 4.18134 17.8497 3.96596L16.125 2.98673C15.7528 2.77539 15.5667 2.66972 15.3997 2.69222C15.2326 2.71472 15.0442 2.90273 14.6672 3.27873C13.208 4.73448 10.7936 4.73442 9.33434 3.27864C8.95743 2.90263 8.76898 2.71463 8.60193 2.69212C8.43489 2.66962 8.24877 2.77529 7.87653 2.98663L6.15184 3.96587C5.77253 4.18123 5.58287 4.28891 5.51678 4.44515C5.45068 4.6014 5.51987 4.86787 5.65825 5.4008C6.16137 7.3385 4.93972 9.37763 2.98902 9.9036C2.46712 10.0443 2.20617 10.1147 2.10308 10.2492C2 10.3838 2 10.6003 2 11.0332V12.9669C2 13.3998 2 13.6163 2.10308 13.7508C2.20615 13.8854 2.46711 13.9558 2.98902 14.0965C4.9394 14.6225 6.16008 16.6616 5.65672 18.5992C5.51829 19.1321 5.44907 19.3985 5.51516 19.5548C5.58126 19.7111 5.77092 19.8188 6.15025 20.0341L7.87495 21.0134C8.24721 21.2247 8.43334 21.3304 8.6004 21.3079C8.76746 21.2854 8.95588 21.0973 9.33271 20.7213C10.7927 19.2644 13.2088 19.2643 14.6689 20.7212C15.0457 21.0973 15.2341 21.2853 15.4012 21.3078C15.5682 21.3303 15.7544 21.2246 16.1266 21.0133L17.8513 20.034C18.2307 19.8187 18.4204 19.711 18.4864 19.5547C18.5525 19.3984 18.4833 19.132 18.3448 18.5991C17.8412 16.6616 19.0609 14.6226 21.011 14.0965Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ArrowExpandIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M8.00001 3.09779C8.00001 3.09779 4.03375 2.74194 3.38784 3.38785C2.74192 4.03375 3.09784 8 3.09784 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8.00001 20.9022C8.00001 20.9022 4.03375 21.2581 3.38784 20.6122C2.74192 19.9662 3.09784 16 3.09784 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 3.09779C16 3.09779 19.9663 2.74194 20.6122 3.38785C21.2581 4.03375 20.9022 8 20.9022 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 20.9022C16 20.9022 19.9663 21.2581 20.6122 20.6122C21.2581 19.9662 20.9022 16 20.9022 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14.0107 9.99847L20.0625 3.94678"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.99696 14.0024L3.63966 20.3807"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.99732 10.0024L3.84571 3.85889"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13.9795 14.0024L20.5279 20.4983"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Menu01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 5L20 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 12L20 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 19L20 19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function NeuralNetworkIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M21.5 12C21.5 13.3807 20.3807 14.5 19 14.5C17.6193 14.5 16.5 13.3807 16.5 12C16.5 10.6193 17.6193 9.5 19 9.5C20.3807 9.5 21.5 10.6193 21.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M13.5 4C13.5 4.82843 12.8284 5.5 12 5.5C11.1716 5.5 10.5 4.82843 10.5 4C10.5 3.17157 11.1716 2.5 12 2.5C12.8284 2.5 13.5 3.17157 13.5 4Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M12.5 11.5C12.5 12.3284 11.8284 13 11 13C10.1716 13 9.5 12.3284 9.5 11.5C9.5 10.6716 10.1716 10 11 10C11.8284 10 12.5 10.6716 12.5 11.5Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M6.5 7.5C6.5 8.60457 5.60457 9.5 4.5 9.5C3.39543 9.5 2.5 8.60457 2.5 7.5C2.5 6.39543 3.39543 5.5 4.5 5.5C5.60457 5.5 6.5 6.39543 6.5 7.5Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M10.5 19.5C10.5 20.6046 9.60457 21.5 8.5 21.5C7.39543 21.5 6.5 20.6046 6.5 19.5C6.5 18.3954 7.39543 17.5 8.5 17.5C9.60457 17.5 10.5 18.3954 10.5 19.5Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M13.5 5L17.5 10M14.5 15.5L10.5 18.5M8 17.5L5 9.5M6.31298 6.65431L10.5 4.5M12.5 11.5L16.505 11.8443"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 5.5L11 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PuzzleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12.828 6.00096C12.9388 5.68791 12.999 5.35099 12.999 5C12.999 3.34315 11.6559 2 9.99904 2C8.34219 2 6.99904 3.34315 6.99904 5C6.99904 5.35099 7.05932 5.68791 7.17008 6.00096C4.88532 6.0093 3.66601 6.09039 2.87772 6.87868C2.08951 7.66689 2.00836 8.88603 2 11.1704C2.31251 11.06 2.64876 11 2.99904 11C4.6559 11 5.99904 12.3431 5.99904 14C5.99904 15.6569 4.6559 17 2.99904 17C2.64876 17 2.31251 16.94 2 16.8296C2.00836 19.114 2.08951 20.3331 2.87772 21.1213C3.66593 21.9095 4.88508 21.9907 7.16941 21.999C7.05908 21.6865 6.99904 21.3503 6.99904 21C6.99904 19.3431 8.34219 18 9.99904 18C11.6559 18 12.999 19.3431 12.999 21C12.999 21.3503 12.939 21.6865 12.8287 21.999C15.113 21.9907 16.3322 21.9095 17.1204 21.1213C17.9086 20.333 17.9897 19.1137 17.9981 16.829C18.3111 16.9397 18.648 17 18.999 17C20.6559 17 21.999 15.6569 21.999 14C21.999 12.3431 20.6559 11 18.999 11C18.648 11 18.3111 11.0603 17.9981 11.171C17.9897 8.88627 17.9086 7.66697 17.1204 6.87868C16.3321 6.09039 15.1128 6.0093 12.828 6.00096Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function McpServerIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3.49994 11.7501L11.6717 3.57855C12.7762 2.47398 14.5672 2.47398 15.6717 3.57855C16.7762 4.68312 16.7762 6.47398 15.6717 7.57855M15.6717 7.57855L9.49994 13.7501M15.6717 7.57855C16.7762 6.47398 18.5672 6.47398 19.6717 7.57855C20.7762 8.68312 20.7762 10.474 19.6717 11.5785L12.7072 18.543C12.3167 18.9335 12.3167 19.5667 12.7072 19.9572L13.9999 21.2499"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.4999 9.74921L11.3282 15.921C10.2237 17.0255 8.43272 17.0255 7.32822 15.921C6.22373 14.8164 6.22373 13.0255 7.32822 11.921L13.4999 5.74939"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Key01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M15.5 14.5C18.8137 14.5 21.5 11.8137 21.5 8.5C21.5 5.18629 18.8137 2.5 15.5 2.5C12.1863 2.5 9.5 5.18629 9.5 8.5C9.5 9.38041 9.68962 10.2165 10.0303 10.9697L2.5 18.5V21.5H5.5V19.5H7.5V17.5H9.5L13.0303 13.9697C13.7835 14.3104 14.6196 14.5 15.5 14.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.5 6.5L16.5 7.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function DnaIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle cx={12} cy={12} r={5} stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path
        d="M22.0004 8.44332C20.2212 10.2226 17.3364 10.2226 15.5571 8.44332C13.7778 6.66405 13.7778 3.77927 15.5571 2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2 15.5567C3.77927 13.7774 6.66405 13.7774 8.44332 15.5567C10.2226 17.336 10.2226 20.2207 8.44332 22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function AnalyticsUpIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7 18V16M12 18V15M17 18V13M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M5.99219 11.4863C8.14729 11.5581 13.0341 11.2328 15.8137 6.82132M13.9923 6.28835L15.8678 5.98649C16.0964 5.95738 16.432 6.13785 16.5145 6.35298L17.0104 7.99142"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Database02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Ellipse cx={12} cy={5} rx={8} ry={3} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M20 12C20 13.6569 16.4183 15 12 15C7.58172 15 4 13.6569 4 12"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M20 5V19C20 20.6569 16.4183 22 12 22C7.58172 22 4 20.6569 4 19V5"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M8 8V10" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path d="M8 15V17" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
    </IconBase>
  )
}

export function AiMagicIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M10 7L9.48415 8.39405C8.80774 10.222 8.46953 11.136 7.80278 11.8028C7.13603 12.4695 6.22204 12.8077 4.39405 13.4842L3 14L4.39405 14.5158C6.22204 15.1923 7.13603 15.5305 7.80278 16.1972C8.46953 16.864 8.80774 17.778 9.48415 19.6059L10 21L10.5158 19.6059C11.1923 17.778 11.5305 16.864 12.1972 16.1972C12.864 15.5305 13.778 15.1923 15.6059 14.5158L17 14L15.6059 13.4842C13.778 12.8077 12.864 12.4695 12.1972 11.8028C11.5305 11.136 11.1923 10.222 10.5158 8.39405L10 7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M18 3L17.7789 3.59745C17.489 4.38087 17.3441 4.77259 17.0583 5.05833C16.7726 5.34408 16.3809 5.48903 15.5975 5.77892L15 6L15.5975 6.22108C16.3809 6.51097 16.7726 6.65592 17.0583 6.94167C17.3441 7.22741 17.489 7.61913 17.7789 8.40255L18 9L18.2211 8.40255C18.511 7.61913 18.6559 7.22741 18.9417 6.94166C19.2274 6.65592 19.6191 6.51097 20.4025 6.22108L21 6L20.4025 5.77892C19.6191 5.48903 19.2274 5.34408 18.9417 5.05833C18.6559 4.77259 18.511 4.38087 18.2211 3.59745L18 3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PaintBoardIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C12.8417 22 14 22.1163 14 21C14 20.391 13.6832 19.9212 13.3686 19.4544C12.9082 18.7715 12.4523 18.0953 13 17C13.6667 15.6667 14.7778 15.6667 16.4815 15.6667C17.3334 15.6667 18.3334 15.6667 19.5 15.5C21.601 15.1999 22 13.9084 22 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M7 15.002L7.00868 14.9996"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Circle cx={9.5} cy={8.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
      <Circle cx={16.5} cy={9.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
    </IconBase>
  )
}

// Brand logomarks from Simple Icons (via react-icons/si on desktop). Unlike
// the Hugeicons set these are solid fills, not strokes: the desktop renders
// them as fill="currentColor", so the fill on the Path overrides IconBase's
// fill="none" and picks up the surrounding text color.

/** The conversations-started-here badge — the glyph the desktop's Mobile
 *  settings tab and its ChannelIcon both use. */
export function SmartPhone01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12 19H12.01"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M13.5 2H10.5C8.14298 2 6.96447 2 6.23223 2.73223C5.5 3.46447 5.5 4.64298 5.5 7V17C5.5 19.357 5.5 20.5355 6.23223 21.2678C6.96447 22 8.14298 22 10.5 22H13.5C15.857 22 17.0355 22 17.7678 21.2678C18.5 20.5355 18.5 19.357 18.5 17V7C18.5 4.64298 18.5 3.46447 17.7678 2.73223C17.0355 2 15.857 2 13.5 2Z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  )
}

export function TelegramLogo(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
        fill="currentColor"
      />
    </IconBase>
  )
}

export function WhatsAppLogo(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"
        fill="currentColor"
      />
    </IconBase>
  )
}

export function GlobalIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M20 5.69899C19.0653 5.76636 17.8681 6.12824 17.0379 7.20277C15.5385 9.14361 14.039 9.30556 13.0394 8.65861C11.5399 7.6882 12.8 6.11636 11.0401 5.26215C9.89313 4.70542 9.73321 3.19045 10.3716 2"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2 11C2.7625 11.6621 3.83046 12.2682 5.08874 12.2682C7.68843 12.2682 8.20837 12.7649 8.20837 14.7518C8.20837 16.7387 8.20837 16.7387 8.72831 18.2288C9.06651 19.1981 9.18472 20.1674 8.5106 21"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M22 13.4523C21.1129 12.9411 20 12.7308 18.8734 13.5405C16.7177 15.0898 15.2314 13.806 14.5619 15.0889C13.5765 16.9775 17.0957 17.5711 14 22"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CodeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7.99994 12H8.00891M11.9955 12H12.0044M15.991 12H15.9999"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M18 21C19.2322 21 20.231 19.8487 20.231 18.4286C20.231 16.1808 20.1312 14.6864 21.6733 12.9091C22.1089 12.407 22.1089 11.5929 21.6733 11.0908C20.1312 9.31353 20.231 7.81914 20.231 5.57141C20.231 4.15125 19.2322 2.99998 18 2.99998"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6 21C4.76784 21 3.76897 19.8487 3.76897 18.4286C3.76897 16.1808 3.86877 14.6864 2.32673 12.9091C1.89109 12.407 1.89109 11.5929 2.32673 11.0908C3.83496 9.35249 3.76897 7.8399 3.76897 5.57141C3.76897 4.15125 4.76784 2.99998 6 2.99998"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Pdf02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M19 11C19 10.1825 19 9.4306 18.8478 9.06306C18.6955 8.69552 18.4065 8.40649 17.8284 7.82843L13.0919 3.09188C12.593 2.593 12.3436 2.34355 12.0345 2.19575C11.9702 2.165 11.9044 2.13772 11.8372 2.11401C11.5141 2 11.1614 2 10.4558 2C7.21082 2 5.58831 2 4.48933 2.88607C4.26731 3.06508 4.06508 3.26731 3.88607 3.48933C3 4.58831 3 6.21082 3 9.45584V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H19M12 2.5V3C12 5.82843 12 7.24264 12.8787 8.12132C13.7574 9 15.1716 9 18 9H18.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21 14H19C18.4477 14 18 14.4477 18 15V16.5M18 16.5V19M18 16.5H20.5M7 19V17M7 17V14H8.5C9.32843 14 10 14.6716 10 15.5C10 16.3284 9.32843 17 8.5 17H7ZM12.5 14H13.7857C14.7325 14 15.5 14.7462 15.5 15.6667V17.3333C15.5 18.2538 14.7325 19 13.7857 19H12.5V14Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

/**
 * The share affordance — Hugeicons' Upload01, which is the platform share
 * glyph users expect on both stores (open tray + up arrow, iOS
 * `square.and.arrow.up`), not the three-connected-circles graph icon.
 */
export function Upload01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.99994 17C2.99994 17.93 2.99994 18.395 3.10216 18.7765C3.37956 19.8117 4.18821 20.6204 5.22348 20.8978C5.60498 21 6.06997 21 6.99994 21L16.9999 21C17.9299 21 18.3949 21 18.7764 20.8978C19.8117 20.6204 20.6203 19.8117 20.8977 18.7765C20.9999 18.395 20.9999 17.93 20.9999 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16.5 7.49993C16.5 7.49993 13.1858 2.99997 12 2.99996C10.8141 2.99995 7.50002 7.49996 7.50002 7.49996M12 3.99996V16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PresentationBarChart01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12 18V22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M10 18L5 22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14 18L19 22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2.5 12C2.5 14.8284 2.5 16.2426 3.37868 17.1213C4.25736 18 5.67157 18 8.5 18H15.5C18.3284 18 19.7426 18 20.6213 17.1213C21.5 16.2426 21.5 14.8284 21.5 12V8C21.5 5.17157 21.5 3.75736 20.6213 2.87868C19.7426 2 18.3284 2 15.5 2H8.5C5.67157 2 4.25736 2 3.37868 2.87868C2.5 3.75736 2.5 5.17157 2.5 8V12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M8 13V10M12 13V7M16 13V11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Table01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M20 10C20 10 22.375 11.8222 21.375 14.6667C20.375 17.5111 21.375 19.4074 22 20M20 10H4M20 10V4M4 10C4 10 1.625 11.8222 2.625 14.6667C3.625 17.5111 2.625 19.4074 2 20M4 10V4M22 4H20.75H20M2 4H3.25H4M4 4H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11 7H13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Video01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2 11C2 7.70017 2 6.05025 3.02513 5.02513C4.05025 4 5.70017 4 9 4H10C13.2998 4 14.9497 4 15.9749 5.02513C17 6.05025 17 7.70017 17 11V13C17 16.2998 17 17.9497 15.9749 18.9749C14.9497 20 13.2998 20 10 20H9C5.70017 20 4.05025 20 3.02513 18.9749C2 17.9497 2 16.2998 2 13V11Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M17 8.90585L17.1259 8.80196C19.2417 7.05623 20.2996 6.18336 21.1498 6.60482C22 7.02628 22 8.42355 22 11.2181V12.7819C22 15.5765 22 16.9737 21.1498 17.3952C20.2996 17.8166 19.2417 16.9438 17.1259 15.198L17 15.0941"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Circle cx={11.5} cy={9.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
    </IconBase>
  )
}

export function Film01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M2.5 7H21.5" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
      <Path d="M2.5 17H21.5" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
      <Path
        d="M12 17L12 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8 7L8 3M16 7L16 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8 21L8 17M16 21L16 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Database01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M2.5 12H21.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 7L17 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Circle cx={8.25} cy={7} r={1.25} stroke="currentColor" strokeWidth={1.5} />
      <Circle cx={8.25} cy={17} r={1.25} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M13 17L17 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ArrowDown02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M12 18.502V5.00195"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M18 13.002C18 13.002 13.5811 19.0019 12 19.002C10.4188 19.002 6 13.002 6 13.002"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CpuIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 12C4 8.22876 4 6.34315 5.17157 5.17157C6.34315 4 8.22876 4 12 4C15.7712 4 17.6569 4 18.8284 5.17157C20 6.34315 20 8.22876 20 12C20 15.7712 20 17.6569 18.8284 18.8284C17.6569 20 15.7712 20 12 20C8.22876 20 6.34315 20 5.17157 18.8284C4 17.6569 4 15.7712 4 12Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.5 2V4M14.5 2V4M9.5 20V22M14.5 20V22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 9L9 13M15 13L13 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M22 14.5L20 14.5M4 9.5L2 9.5M4 14.5L2 14.5M22 9.5L20 9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function DollarCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M14.7102 10.0611C14.6111 9.29844 13.7354 8.06622 12.1608 8.06619C10.3312 8.06616 9.56136 9.07946 9.40515 9.58611C9.16145 10.2638 9.21019 11.6571 11.3547 11.809C14.0354 11.999 15.1093 12.3154 14.9727 13.956C14.836 15.5965 13.3417 15.951 12.1608 15.9129C10.9798 15.875 9.04764 15.3325 8.97266 13.8733M11.9734 6.99805V8.06982M11.9734 15.9031V16.998"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function HourglassIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 3H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M5.5 3V5.03039C5.5 6.27227 6.07682 7.4437 7.06116 8.20089L12 12L16.9388 8.20089C17.9232 7.44371 18.5 6.27227 18.5 5.03039V3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M5.5 21V18.9696C5.5 17.7277 6.07682 16.5563 7.06116 15.7991L12 12L16.9388 15.7991C17.9232 16.5563 18.5 17.7277 18.5 18.9696V21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 21H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function RepeatIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M16.3884 3L17.3913 3.97574C17.8393 4.41165 18.0633 4.62961 17.9844 4.81481C17.9056 5 17.5888 5 16.9552 5H9.19422C5.22096 5 2 8.13401 2 12C2 13.4872 2.47668 14.8662 3.2895 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7.61156 21L6.60875 20.0243C6.16074 19.5883 5.93673 19.3704 6.01557 19.1852C6.09441 19 6.4112 19 7.04478 19H14.8058C18.779 19 22 15.866 22 12C22 10.5128 21.5233 9.13383 20.7105 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function VolumeHighIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17 9C17.6254 9.81968 18 10.8634 18 12C18 13.1366 17.6254 14.1803 17 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20 7C21.2508 8.36613 22 10.1057 22 12C22 13.8943 21.2508 15.6339 20 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function SmileDizzyIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle
        cx={12}
        cy={12}
        r={10}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M10 11L8.5 9.5M8.5 9.5L7 8M8.5 9.5L7 11M8.5 9.5L10 8M17 11L15.5 9.5M15.5 9.5L14 8M15.5 9.5L14 11M15.5 9.5L17 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8 15C8.91212 16.2144 10.3643 17 12 17C13.6357 17 15.0879 16.2144 16 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function BrowserIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M2.5 9H21.5" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
      <Path
        d="M6.99981 6H7.00879"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M10.9998 6H11.0088"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </IconBase>
  )
}

export function CheckmarkBadge01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M18.9905 19H19M18.9905 19C18.3678 19.6175 17.2393 19.4637 16.4479 19.4637C15.4765 19.4637 15.0087 19.6537 14.3154 20.347C13.7251 20.9374 12.9337 22 12 22C11.0663 22 10.2749 20.9374 9.68457 20.347C8.99128 19.6537 8.52349 19.4637 7.55206 19.4637C6.76068 19.4637 5.63218 19.6175 5.00949 19C4.38181 18.3776 4.53628 17.2444 4.53628 16.4479C4.53628 15.4414 4.31616 14.9786 3.59938 14.2618C2.53314 13.1956 2.00002 12.6624 2 12C2.00001 11.3375 2.53312 10.8044 3.59935 9.73817C4.2392 9.09832 4.53628 8.46428 4.53628 7.55206C4.53628 6.76065 4.38249 5.63214 5 5.00944C5.62243 4.38178 6.7556 4.53626 7.55208 4.53626C8.46427 4.53626 9.09832 4.2392 9.73815 3.59937C10.8044 2.53312 11.3375 2 12 2C12.6625 2 13.1956 2.53312 14.2618 3.59937C14.9015 4.23907 15.5355 4.53626 16.4479 4.53626C17.2393 4.53626 18.3679 4.38247 18.9906 5C19.6182 5.62243 19.4637 6.75559 19.4637 7.55206C19.4637 8.55858 19.6839 9.02137 20.4006 9.73817C21.4669 10.8044 22 11.3375 22 12C22 12.6624 21.4669 13.1956 20.4006 14.2618C19.6838 14.9786 19.4637 15.4414 19.4637 16.4479C19.4637 17.2444 19.6182 18.3776 18.9905 19Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M9 12.8929C9 12.8929 10.2 13.5447 10.8 14.5C10.8 14.5 12.6 10.75 15 9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function SecurityCheckIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M18.7088 3.49534C16.8165 2.55382 14.5009 2 12 2C9.4991 2 7.1835 2.55382 5.29116 3.49534C4.36318 3.95706 3.89919 4.18792 3.4496 4.91378C3 5.63965 3 6.34248 3 7.74814V11.2371C3 16.9205 7.54236 20.0804 10.173 21.4338C10.9067 21.8113 11.2735 22 12 22C12.7265 22 13.0933 21.8113 13.8269 21.4338C16.4576 20.0804 21 16.9205 21 11.2371L21 7.74814C21 6.34249 21 5.63966 20.5504 4.91378C20.1008 4.18791 19.6368 3.95706 18.7088 3.49534Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9 11.5C9 11.5 10.4079 11.7519 11 13.5C11 13.5 12.5 10.5 15 9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function SquareLock02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path d="M12 16.5V14.5" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path
        d="M4.2678 18.8447C4.49268 20.515 5.87612 21.8235 7.55965 21.9009C8.97627 21.966 10.4153 22 12 22C13.5847 22 15.0237 21.966 16.4403 21.9009C18.1239 21.8235 19.5073 20.515 19.7322 18.8447C19.8789 17.7547 20 16.6376 20 15.5C20 14.3624 19.8789 13.2453 19.7322 12.1553C19.5073 10.485 18.1239 9.17649 16.4403 9.09909C15.0237 9.03397 13.5847 9 12 9C10.4153 9 8.97627 9.03397 7.55965 9.09909C5.87612 9.17649 4.49268 10.485 4.2678 12.1553C4.12104 13.2453 3.99999 14.3624 3.99999 15.5C3.99999 16.6376 4.12104 17.7547 4.2678 18.8447Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M7.5 9V6.5C7.5 4.01472 9.51472 2 12 2C14.4853 2 16.5 4.01472 16.5 6.5V9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function HelpCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle
        cx={12}
        cy={12}
        r={10}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.5 9.5C9.5 8.11929 10.6193 7 12 7C13.3807 7 14.5 8.11929 14.5 9.5C14.5 10.3569 14.0689 11.1131 13.4117 11.5636C12.7283 12.0319 12 12.6716 12 13.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12.0001 17H12.009"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </IconBase>
  )
}

export function MessageQuestionIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14.1706 20.8905C18.3536 20.6125 21.6856 17.2332 21.9598 12.9909C22.0134 12.1607 22.0134 11.3009 21.9598 10.4707C21.6856 6.22838 18.3536 2.84913 14.1706 2.57107C12.7435 2.47621 11.2536 2.47641 9.8294 2.57107C5.64639 2.84913 2.31441 6.22838 2.04024 10.4707C1.98659 11.3009 1.98659 12.1607 2.04024 12.9909C2.1401 14.536 2.82343 15.9666 3.62791 17.1746C4.09501 18.0203 3.78674 19.0758 3.30021 19.9978C2.94941 20.6626 2.77401 20.995 2.91484 21.2351C3.05568 21.4752 3.37026 21.4829 3.99943 21.4982C5.24367 21.5285 6.08268 21.1757 6.74868 20.6846C7.1264 20.4061 7.31527 20.2668 7.44544 20.2508C7.5756 20.2348 7.83177 20.3403 8.34401 20.5513C8.8044 20.7409 9.33896 20.8579 9.8294 20.8905C11.2536 20.9852 12.7435 20.9854 14.1706 20.8905Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M10.5 9.53846C10.5 8.68879 11.1716 8 12 8C12.8284 8 13.5 8.68879 13.5 9.53846C13.5 9.84473 13.4127 10.1301 13.2623 10.3698C12.8141 11.0844 12 11.7657 12 12.6154V13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 15H12.009"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function SentIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M21.0477 3.05293C18.8697 0.707363 2.48648 6.4532 2.50001 8.551C2.51535 10.9299 8.89809 11.6617 10.6672 12.1581C11.7311 12.4565 12.016 12.7625 12.2613 13.8781C13.3723 18.9305 13.9301 21.4435 15.2014 21.4996C17.2278 21.5892 23.1733 5.342 21.0477 3.05293Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M11.4999 12.5L14.9999 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function MessageMultiple01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7.5 12H13.5M7.5 8H10.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M8.5 20C9.55038 20.8697 10.8145 21.4238 12.2635 21.5188C13.4052 21.5937 14.5971 21.5936 15.7365 21.5188C16.1288 21.4931 16.5565 21.4007 16.9248 21.251C17.3345 21.0845 17.5395 21.0012 17.6437 21.0138C17.7478 21.0264 17.8989 21.1364 18.2011 21.3563C18.7339 21.744 19.4051 22.0225 20.4005 21.9986C20.9038 21.9865 21.1555 21.9804 21.2681 21.7909C21.3808 21.6013 21.2405 21.3389 20.9598 20.8141C20.5706 20.0862 20.324 19.2529 20.6977 18.5852C21.3413 17.6315 21.8879 16.5021 21.9678 15.2823C22.0107 14.6269 22.0107 13.9481 21.9678 13.2927C21.9146 12.4799 21.7173 11.7073 21.4012 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12.345 17.4868C15.9006 17.2526 18.7328 14.4069 18.9658 10.8344C19.0114 10.1353 19.0114 9.41131 18.9658 8.71219C18.7328 5.13969 15.9006 2.29401 12.345 2.05985C11.132 1.97997 9.86553 1.98013 8.65499 2.05985C5.09943 2.29401 2.26725 5.13969 2.0342 8.71219C1.9886 9.41131 1.9886 10.1353 2.0342 10.8344C2.11908 12.1356 2.69992 13.3403 3.38372 14.3576C3.78076 15.0697 3.51873 15.9586 3.10518 16.735C2.807 17.2948 2.65791 17.5747 2.77762 17.7769C2.89732 17.9791 3.16472 17.9856 3.69951 17.9985C4.75712 18.024 5.47028 17.7269 6.03638 17.3134C6.35744 17.0788 6.51798 16.9615 6.62862 16.9481C6.73926 16.9346 6.957 17.0234 7.39241 17.2011C7.78374 17.3608 8.23812 17.4593 8.65499 17.4868C9.86553 17.5665 11.132 17.5666 12.345 17.4868Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function CalendarCheckOut02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M16 2V6M8 2V6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 4H11C7.22876 4 5.34315 4 4.17157 5.17157C3 6.34315 3 8.22876 3 12V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V12C21 8.22876 21 6.34315 19.8284 5.17157C18.6569 4 16.7712 4 13 4Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3 10H21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13.5 18.5C14.0057 18.0085 16 16.7002 16 16C16 15.2998 14.0057 13.9915 13.5 13.5M15.5 16L9 16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function StarIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M13.7276 3.44418L15.4874 6.99288C15.7274 7.48687 16.3673 7.9607 16.9073 8.05143L20.0969 8.58575C22.1367 8.92853 22.6167 10.4206 21.1468 11.8925L18.6671 14.3927C18.2471 14.8161 18.0172 15.6327 18.1471 16.2175L18.8571 19.3125C19.417 21.7623 18.1271 22.71 15.9774 21.4296L12.9877 19.6452C12.4478 19.3226 11.5579 19.3226 11.0079 19.6452L8.01827 21.4296C5.8785 22.71 4.57865 21.7522 5.13859 19.3125L5.84851 16.2175C5.97849 15.6327 5.74852 14.8161 5.32856 14.3927L2.84884 11.8925C1.389 10.4206 1.85895 8.92853 3.89872 8.58575L7.08837 8.05143C7.61831 7.9607 8.25824 7.48687 8.49821 6.99288L10.258 3.44418C11.2179 1.51861 12.7777 1.51861 13.7276 3.44418Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ChartAverageIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M21 21H10C6.70017 21 5.05025 21 4.02513 19.9749C3 18.9497 3 17.2998 3 14V3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6 12H6.00898M8.9982 12H9.00718M11.9964 12H12.0054M14.9946 12H15.0036M17.9928 12H18.0018M20.991 12H21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6 7C6.67348 5.87847 7.58712 5 8.99282 5C14.9359 5 11.5954 17 17.9819 17C19.3976 17 20.3057 16.1157 21 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ChartUpIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M20.5 10.5V19.5C20.5 19.9659 20.5 20.1989 20.4239 20.3827C20.3224 20.6277 20.1277 20.8224 19.8827 20.9239C19.6989 21 19.4659 21 19 21C18.5341 21 18.3011 21 18.1173 20.9239C17.8723 20.8224 17.6776 20.6277 17.5761 20.3827C17.5 20.1989 17.5 19.9659 17.5 19.5V10.5C17.5 10.0341 17.5 9.80109 17.5761 9.61732C17.6776 9.37229 17.8723 9.17761 18.1173 9.07612C18.3011 9 18.5341 9 19 9C19.4659 9 19.6989 9 19.8827 9.07612C20.1277 9.17761 20.3224 9.37229 20.4239 9.61732C20.5 9.80109 20.5 10.0341 20.5 10.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16.5 3H19.5V6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M19 3.5C19 3.5 15 8.5 4.5 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13.5 14V19.5C13.5 19.9659 13.5 20.1989 13.4239 20.3827C13.3224 20.6277 13.1277 20.8224 12.8827 20.9239C12.6989 21 12.4659 21 12 21C11.5341 21 11.3011 21 11.1173 20.9239C10.8723 20.8224 10.6776 20.6277 10.5761 20.3827C10.5 20.1989 10.5 19.9659 10.5 19.5V14C10.5 13.5341 10.5 13.3011 10.5761 13.1173C10.6776 12.8723 10.8723 12.6776 11.1173 12.5761C11.3011 12.5 11.5341 12.5 12 12.5C12.4659 12.5 12.6989 12.5 12.8827 12.5761C13.1277 12.6776 13.3224 12.8723 13.4239 13.1173C13.5 13.3011 13.5 13.5341 13.5 14Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6.5 16.5V19.5C6.5 19.9659 6.5 20.1989 6.42388 20.3827C6.32239 20.6277 6.12771 20.8224 5.88268 20.9239C5.69891 21 5.46594 21 5 21C4.53406 21 4.30109 21 4.11732 20.9239C3.87229 20.8224 3.67761 20.6277 3.57612 20.3827C3.5 20.1989 3.5 19.9659 3.5 19.5V16.5C3.5 16.0341 3.5 15.8011 3.57612 15.6173C3.67761 15.3723 3.87229 15.1776 4.11732 15.0761C4.30109 15 4.53406 15 5 15C5.46594 15 5.69891 15 5.88268 15.0761C6.12771 15.1776 6.32239 15.3723 6.42388 15.6173C6.5 15.8011 6.5 16.0341 6.5 16.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Wallet01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14 3H5C3.89543 3 3 3.89543 3 5C3 6.10457 3.89543 7 5 7H18C18 6.07003 18 5.60504 17.8978 5.22354C17.6204 4.18827 16.8117 3.37962 15.7765 3.10222C15.395 3 14.93 3 14 3Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3 5V15C3 17.8284 3 19.2426 3.87868 20.1213C4.75736 21 6.17157 21 9 21H15C17.8284 21 19.2426 21 20.1213 20.1213C21 19.2426 21 17.8284 21 15V13C21 10.1716 21 8.75736 20.1213 7.87868C19.2426 7 17.8284 7 15 7H7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21 12H19C18.535 12 18.3025 12 18.1118 12.0511C17.5941 12.1898 17.1898 12.5941 17.0511 13.1118C17 13.3025 17 13.535 17 14C17 14.465 17 14.6975 17.0511 14.8882C17.1898 15.4059 17.5941 15.8102 18.1118 15.9489C18.3025 16 18.535 16 19 16H21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function HardDriveIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M20.7104 8.70122L21.9186 12.7288C21.9578 12.8592 21.9773 12.9244 21.9879 12.9914L21.9908 13.0118C22 13.079 22 13.147 22 13.2831C22 16.7797 22 18.528 20.9812 19.6669C20.8824 19.7774 20.7774 19.8824 20.6669 19.9812C19.528 21 17.7797 21 14.2831 21H9.71685C6.22026 21 4.47197 21 3.33311 19.9812C3.22259 19.8824 3.11765 19.7774 3.01877 19.6669C2 18.528 2 16.7797 2 13.2831C2 13.147 2 13.079 2.00915 13.0118L2.01215 12.9914C2.02269 12.9244 2.04225 12.8592 2.08136 12.7288L3.28963 8.70122C4.11355 5.95484 4.5255 4.58166 5.5884 3.79083C6.6513 3 8.08495 3 10.9522 3H13.0478C15.9151 3 17.3487 3 18.4116 3.79083C19.4745 4.58166 19.8865 5.95484 20.7104 8.70122Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M2 13H22" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
      <Path
        d="M17.9888 17H18M13 17H13.0112"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </IconBase>
  )
}

export function RamMemoryIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2 12.5C3.10457 12.5 4 11.6046 4 10.5C4 9.39543 3.10457 8.5 2 8.5C2 7.09554 2 6.39331 2.33706 5.88886C2.48298 5.67048 2.67048 5.48298 2.88886 5.33706C3.39331 5 4.09554 5 5.5 5H18.5C19.9045 5 20.6067 5 21.1111 5.33706C21.3295 5.48298 21.517 5.67048 21.6629 5.88886C22 6.39331 22 7.09554 22 8.5C20.8954 8.5 20 9.39543 20 10.5C20 11.6046 20.8954 12.5 22 12.5C22 13.9045 22 14.6067 21.6629 15.1111C21.517 15.3295 21.3295 15.517 21.1111 15.6629C20.6067 16 19.9045 16 18.5 16H5.5C4.09554 16 3.39331 16 2.88886 15.6629C2.67048 15.517 2.48298 15.3295 2.33706 15.1111C2 14.6067 2 13.9045 2 12.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 16V18C4 18.5523 4.44772 19 5 19H8C8.55228 19 9 18.5523 9 18V16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 16V18C13 18.5523 13.4477 19 14 19H19C19.5523 19 20 18.5523 20 18V16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 9V12M16 9V12M8 9V12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Pulse01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2 12H6L7.5 8L9.5 15L13 6L15.5 18L18 12H22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function WasteIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3 5H8.42963C9.09834 5 9.7228 4.6658 10.0937 4.1094L10.9063 2.8906C11.2772 2.3342 11.9017 2 12.5704 2H17.0585C17.9193 2 18.6836 2.55086 18.9558 3.36754L19.5 5M21 5H8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M19.5 5L18.8803 14.906C18.8588 15.2333 18.8387 15.5385 18.8185 15.8235M4.5 5L5.10461 14.8966C5.25945 17.3107 5.33688 18.5177 5.97868 19.3857C6.296 19.8149 6.7048 20.1771 7.17905 20.4493C8.1383 21 9.42312 21 11.9927 21H14.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20 19C20 17.3431 18.6569 16 17 16C15.3431 16 14 17.3431 14 19C14 20.6569 15.3431 22 17 22C18.6569 22 20 20.6569 20 19Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Globe02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M8 12C8 18 12 22 12 22C12 22 16 18 16 12C16 6 12 2 12 2C12 2 8 6 8 12Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21 15H3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21 9H3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function QrCode01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M8.99396 2C6.19709 2.06395 4.56347 2.33111 3.44729 3.44729C2.33111 4.56347 2.06395 6.19709 2 8.99396M15.006 2C17.8029 2.06395 19.4365 2.33111 20.5527 3.44729C21.6689 4.56347 21.9361 6.19709 22 8.99396M15.006 22C17.8029 21.9361 19.4365 21.6689 20.5527 20.5527C21.6689 19.4365 21.9361 17.8029 22 15.006M8.99396 22C6.19709 21.9361 4.56347 21.6689 3.44729 20.5527C2.33111 19.4365 2.06395 17.8029 2 15.006"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16.9998 7H17.0088"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M13 6V9C13 10.8856 13 11.8284 12.4142 12.4142C11.8284 13 10.8856 13 9 13H6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6.29289 6.29289C6 6.58579 6 7.05719 6 8C6 8.94281 6 9.41421 6.29289 9.70711M6.29289 6.29289C6.58579 6 7.05719 6 8 6C8.94281 6 9.41421 6 9.70711 6.29289M6.29289 9.70711C6.58579 10 7.05719 10 8 10C8.94281 10 9.41421 10 9.70711 9.70711M9.70711 9.70711C10 9.41421 10 8.94281 10 8C10 7.05719 10 6.58579 9.70711 6.29289"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M17 15C17.4714 15 17.7071 15 17.8536 15.1464C18 15.2929 18 15.5286 18 16V17C18 17.4714 18 17.7071 17.8536 17.8536C17.7071 18 17.4714 18 17 18H15C14.5286 18 14.2929 18 14.1464 17.8536C14 17.7071 14 17.4714 14 17L14 16C14 15.5286 14 15.2929 14.1464 15.1464C14.2929 15 14.5286 15 15 15L17 15Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path d="M6 18H11" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      <Path d="M17 10L17 12" stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
    </IconBase>
  )
}

export function KeyboardIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14.5 7H9.5C6.21252 7 4.56878 7 3.46243 7.90796C3.25989 8.07418 3.07418 8.25989 2.90796 8.46243C2 9.56878 2 11.2125 2 14.5C2 17.7875 2 19.4312 2.90796 20.5376C3.07418 20.7401 3.25989 20.9258 3.46243 21.092C4.56878 22 6.21252 22 9.5 22H14.5C17.7875 22 19.4312 22 20.5376 21.092C20.7401 20.9258 20.9258 20.7401 21.092 20.5376C22 19.4312 22 17.7875 22 14.5C22 11.2125 22 9.56878 21.092 8.46243C20.9258 8.25989 20.7401 8.07418 20.5376 7.90796C19.4312 7 17.7875 7 14.5 7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12 7V5C12 4.44772 12.4477 4 13 4C13.5523 4 14 3.55228 14 3V2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7 12L8 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.5 12L12.5 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 12L17 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7 17L17 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

/**
 * Not a verbatim Hugeicons path like the rest of this file: the free set has
 * no keyboard-dismiss glyph, so this one is composed in its language —
 * KeyboardIcon's key rows in a squatter body, over ArrowDown01Icon's chevron
 * scaled to sit beneath it. The same picture Material ships as keyboard_hide
 * and the iPad keyboard wears on its dismiss key.
 */
export function KeyboardHideIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Rect x={2} y={3.5} width={20} height={11} rx={3} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M7 7.25L8 7.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.5 7.25L12.5 7.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 7.25L17 7.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7 11L17 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 18C16 18 13.0541 21.75 12 21.75C10.9459 21.75 8 18 8 18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function ChartLineData02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle cx={8.5} cy={10.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
      <Circle cx={14.5} cy={15.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
      <Circle cx={18.5} cy={7.5} r={1.5} stroke="currentColor" strokeWidth={1.5} />
      <Path
        d="M15.4341 14.2963L18 9M9.58251 11.5684L13.2038 14.2963M3 19L7.58957 11.8792"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20 21H9C5.70017 21 4.05025 21 3.02513 19.9749C2 18.9497 2 17.2998 2 14V3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Image01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle
        cx={7.5}
        cy={7.5}
        r={1.5}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M5 21C9.37246 15.775 14.2741 8.88406 21.4975 13.5424"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

/** hugeicons Attachment01 — the same glyph the desktop cards use. */
export function Attachment01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M5.82338 12L4.27922 10.4558C2.57359 8.75022 2.57359 5.98485 4.27922 4.27922C5.98485 2.57359 8.75022 2.57359 10.4558 4.27922L19.7208 13.5442C21.4264 15.2498 21.4264 18.0152 19.7208 19.7208C18.0152 21.4264 15.2498 21.4264 13.5442 19.7208L10.0698 16.2464C9.00379 15.1804 9.00379 13.4521 10.0698 12.386C11.1358 11.32 12.8642 11.32 13.9302 12.386L15.8604 14.3162"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Folder01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PlayListIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.50012 7.5H21.5001"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.0001 2.5L14.0001 7.5"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M10.0001 2.5L7.00012 7.5"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M14.9531 14.8948C14.8016 15.5215 14.0857 15.9644 12.6539 16.8502C11.2697 17.7064 10.5777 18.1346 10.0199 17.9625C9.78934 17.8913 9.57925 17.7562 9.40982 17.57C9 17.1198 9 16.2465 9 14.5C9 12.7535 9 11.8802 9.40982 11.4299C9.57925 11.2438 9.78934 11.1087 10.0199 11.0375C10.5777 10.8654 11.2697 11.2936 12.6539 12.1498C14.0857 13.0356 14.8016 13.4785 14.9531 14.1052C15.0156 14.3639 15.0156 14.6361 14.9531 14.8948Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function HeartCheckIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M13 20.3025C12.1525 20.6505 11.1746 20.5389 10.4107 19.9677C7.58942 17.858 2 13.0348 2 8.69444C2 5.82563 4.10526 3.5 7 3.5C8.5 3.5 10 4 12 6C14 4 15.5 3.5 17 3.5C19.8947 3.5 22 5.82563 22 8.69444C22 9.12591 21.9448 9.56214 21.8425 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14 17C14 17 15 17 16 19C16 19 19.1765 14 22 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Edit02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14.0737 3.88545C14.8189 3.07808 15.1915 2.6744 15.5874 2.43893C16.5427 1.87076 17.7191 1.85309 18.6904 2.39232C19.0929 2.6158 19.4769 3.00812 20.245 3.79276C21.0131 4.5774 21.3972 4.96972 21.6159 5.38093C22.1438 6.37312 22.1265 7.57479 21.5703 8.5507C21.3398 8.95516 20.9446 9.33578 20.1543 10.097L10.7506 19.1543C9.25288 20.5969 8.504 21.3182 7.56806 21.6837C6.63212 22.0493 5.6032 22.0224 3.54536 21.9686L3.26538 21.9613C2.63891 21.9449 2.32567 21.9367 2.14359 21.73C1.9615 21.5234 1.98636 21.2043 2.03608 20.5662L2.06308 20.2197C2.20301 18.4235 2.27297 17.5255 2.62371 16.7182C2.97444 15.9109 3.57944 15.2555 4.78943 13.9445L14.0737 3.88545Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path d="M13 4L20 11" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
      <Path
        d="M14 22L22 22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function SourceCodeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17 8L18.8398 9.85008C19.6133 10.6279 20 11.0168 20 11.5C20 11.9832 19.6133 12.3721 18.8398 13.1499L17 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7 8L5.16019 9.85008C4.38673 10.6279 4 11.0168 4 11.5C4 11.9832 4.38673 12.3721 5.16019 13.1499L7 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14.5 4L9.5 20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function GridViewIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3.88884 9.66294C4.39329 10 5.09552 10 6.49998 10C7.90445 10 8.60668 10 9.11113 9.66294C9.32951 9.51702 9.51701 9.32952 9.66292 9.11114C9.99998 8.60669 9.99998 7.90446 9.99998 6.5C9.99998 5.09554 9.99998 4.39331 9.66292 3.88886C9.51701 3.67048 9.32951 3.48298 9.11113 3.33706C8.60668 3 7.90445 3 6.49998 3C5.09552 3 4.39329 3 3.88884 3.33706C3.67046 3.48298 3.48296 3.67048 3.33705 3.88886C2.99998 4.39331 2.99998 5.09554 2.99998 6.5C2.99998 7.90446 2.99998 8.60669 3.33705 9.11114C3.48296 9.32952 3.67046 9.51702 3.88884 9.66294Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14.8888 9.66294C15.3933 10 16.0955 10 17.5 10C18.9044 10 19.6067 10 20.1111 9.66294C20.3295 9.51702 20.517 9.32952 20.6629 9.11114C21 8.60669 21 7.90446 21 6.5C21 5.09554 21 4.39331 20.6629 3.88886C20.517 3.67048 20.3295 3.48298 20.1111 3.33706C19.6067 3 18.9044 3 17.5 3C16.0955 3 15.3933 3 14.8888 3.33706C14.6705 3.48298 14.483 3.67048 14.337 3.88886C14 4.39331 14 5.09554 14 6.5C14 7.90446 14 8.60669 14.337 9.11114C14.483 9.32952 14.6705 9.51702 14.8888 9.66294Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3.88884 20.6629C4.39329 21 5.09552 21 6.49998 21C7.90445 21 8.60668 21 9.11113 20.6629C9.32951 20.517 9.51701 20.3295 9.66292 20.1111C9.99998 19.6067 9.99998 18.9045 9.99998 17.5C9.99998 16.0955 9.99998 15.3933 9.66292 14.8889C9.51701 14.6705 9.32951 14.483 9.11113 14.3371C8.60668 14 7.90445 14 6.49998 14C5.09552 14 4.39329 14 3.88884 14.3371C3.67046 14.483 3.48296 14.6705 3.33705 14.8889C2.99998 15.3933 2.99998 16.0955 2.99998 17.5C2.99998 18.9045 2.99998 19.6067 3.33705 20.1111C3.48296 20.3295 3.67046 20.517 3.88884 20.6629Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M14.8888 20.6629C15.3933 21 16.0955 21 17.5 21C18.9044 21 19.6067 21 20.1111 20.6629C20.3295 20.517 20.517 20.3295 20.6629 20.1111C21 19.6067 21 18.9045 21 17.5C21 16.0955 21 15.3933 20.6629 14.8889C20.517 14.6705 20.3295 14.483 20.1111 14.3371C19.6067 14 18.9044 14 17.5 14C16.0955 14 15.3933 14 14.8888 14.3371C14.6705 14.483 14.483 14.6705 14.337 14.8889C14 15.3933 14 16.0955 14 17.5C14 18.9045 14 19.6067 14.337 20.1111C14.483 20.3295 14.6705 20.517 14.8888 20.6629Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function FloppyDiskIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M8 22V19C8 17.1144 8 16.1716 8.58579 15.5858C9.17157 15 10.1144 15 12 15C13.8856 15 14.8284 15 15.4142 15.5858C16 16.1716 16 17.1144 16 19V22"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M10 7H14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M3 11.8584C3 7.28199 3 4.99376 4.38674 3.54394C4.43797 3.49038 4.49038 3.43797 4.54394 3.38674C5.99376 2 8.28199 2 12.8584 2C13.943 2 14.4655 2.00376 14.9628 2.18936C15.4417 2.3681 15.8429 2.70239 16.6452 3.37099L18.8411 5.20092C19.9027 6.08561 20.4335 6.52795 20.7168 7.13266C21 7.73737 21 8.42833 21 9.81025V13C21 16.7497 21 18.6246 20.0451 19.9389C19.7367 20.3634 19.3634 20.7367 18.9389 21.0451C17.6246 22 15.7497 22 12 22C8.25027 22 6.3754 22 5.06107 21.0451C4.6366 20.7367 4.26331 20.3634 3.95491 19.9389C3 18.6246 3 16.7497 3 13V11.8584Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Bug01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M3.01309 4.99084C2.89323 6.05084 3.55249 8.42285 6.48923 8.42285"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.5951 8.38081C18.8357 8.57881 21.1132 7.49881 20.9957 5.00281"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20.9928 20.9989C21.0528 19.9429 20.1777 17.5549 17.599 17.4229"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6.45163 17.4708C5.65013 17.2308 3.01306 18.3348 3.01306 20.9988"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.3299 6.11884C9.35388 5.09884 9.84533 2.99884 12.0029 2.99884C13.9208 2.99884 14.5861 4.61884 14.676 6.11884M6.26131 9.41884C6.38118 8.63884 7.29216 6.81484 9.36586 6.63484C11.4635 6.55564 14.3403 6.58684 14.8797 6.67084C15.5869 6.73377 17.2951 7.43884 17.7506 9.41884C17.9124 10.4388 17.8285 11.8788 17.8524 12.7188C17.8165 13.5588 17.9207 15.2623 17.7565 16.1388C17.6367 17.0988 16.9894 18.4668 16.1024 19.3068C14.7838 20.7228 11.1639 22.2108 8.03534 19.4508C6.41713 17.8908 6.30925 16.3788 6.18939 15.7788C6.15725 15.4571 6.15875 13.8763 6.16541 12.3588C6.14144 11.046 6.17235 9.78063 6.26131 9.41884Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Path
        d="M3.01306 12.8988H5.9498"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20.9929 12.8988L18.1161 12.8988"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M12.0033 16.4988L12.0033 20.2788"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function PreferenceVerticalIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 11L4 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M19 13L19 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M19 3L19 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.5 3L11.5 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 3L4 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.5 19L11.5 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M2 9.5C2 9.03406 2 8.80109 2.07612 8.61732C2.17761 8.37229 2.37229 8.17761 2.61732 8.07612C2.80109 8 3.03406 8 3.5 8H4.5C4.96594 8 5.19891 8 5.38268 8.07612C5.62771 8.17761 5.82239 8.37229 5.92388 8.61732C6 8.80109 6 9.03406 6 9.5C6 9.96594 6 10.1989 5.92388 10.3827C5.82239 10.6277 5.62771 10.8224 5.38268 10.9239C5.19891 11 4.96594 11 4.5 11H3.5C3.03406 11 2.80109 11 2.61732 10.9239C2.37229 10.8224 2.17761 10.6277 2.07612 10.3827C2 10.1989 2 9.96594 2 9.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17 11.5C17 11.0341 17 10.8011 17.0761 10.6173C17.1776 10.3723 17.3723 10.1776 17.6173 10.0761C17.8011 10 18.0341 10 18.5 10H19.5C19.9659 10 20.1989 10 20.3827 10.0761C20.6277 10.1776 20.8224 10.3723 20.9239 10.6173C21 10.8011 21 11.0341 21 11.5C21 11.9659 21 12.1989 20.9239 12.3827C20.8224 12.6277 20.6277 12.8224 20.3827 12.9239C20.1989 13 19.9659 13 19.5 13H18.5C18.0341 13 17.8011 13 17.6173 12.9239C17.3723 12.8224 17.1776 12.6277 17.0761 12.3827C17 12.1989 17 11.9659 17 11.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M9.5 14.5C9.5 14.0341 9.5 13.8011 9.57612 13.6173C9.67761 13.3723 9.87229 13.1776 10.1173 13.0761C10.3011 13 10.5341 13 11 13H12C12.4659 13 12.6989 13 12.8827 13.0761C13.1277 13.1776 13.3224 13.3723 13.4239 13.6173C13.5 13.8011 13.5 14.0341 13.5 14.5C13.5 14.9659 13.5 15.1989 13.4239 15.3827C13.3224 15.6277 13.1277 15.8224 12.8827 15.9239C12.6989 16 12.4659 16 12 16H11C10.5341 16 10.3011 16 10.1173 15.9239C9.87229 15.8224 9.67761 15.6277 9.57612 15.3827C9.5 15.1989 9.5 14.9659 9.5 14.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Task01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M14.4961 2.00027H9.49609C8.66767 2.00027 7.99609 2.67185 7.99609 3.50027C7.99609 4.3287 8.66767 5.00027 9.49609 5.00027H14.4961C15.3245 5.00027 15.9961 4.3287 15.9961 3.50027C15.9961 2.67185 15.3245 2.00027 14.4961 2.00027Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M7.99609 15.0003H11.4247M7.99609 11.0003H15.9961"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M15.9961 3.50027C17.5496 3.54709 18.4761 3.72035 19.1174 4.36164C19.9961 5.24032 19.9961 6.65451 19.9961 9.4829L19.9961 15.9997C19.9961 18.8282 19.9961 20.2424 19.1174 21.1211C18.2387 21.9997 16.8245 21.9997 13.9961 21.9997L9.99609 21.9997C7.16767 21.9997 5.75346 21.9997 4.87478 21.1211C3.9961 20.2424 3.9961 18.8282 3.99609 15.9998L3.99611 9.48296C3.9961 6.65453 3.9961 5.24031 4.87478 4.36163C5.51606 3.72034 6.44261 3.54708 7.99599 3.50027"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Loading03Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      {[
        'M12 3V6',
        'M12 18V21',
        'M21 12L18 12',
        'M6 12L3 12',
        'M18.3635 5.63672L16.2422 7.75804',
        'M7.75804 16.2422L5.63672 18.3635',
        'M18.3635 18.3635L16.2422 16.2422',
        'M7.75804 7.75804L5.63672 5.63672'
      ].map((d) => (
        <Path key={d} d={d} stroke="currentColor" strokeLinecap="round" strokeWidth={1.5} />
      ))}
    </IconBase>
  )
}

export function CircleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Circle
        cx={12}
        cy={12}
        r={10}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function LibraryIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2 7C2 5.59987 2 4.8998 2.27248 4.36502C2.51217 3.89462 2.89462 3.51217 3.36502 3.27248C3.8998 3 4.59987 3 6 3C7.40013 3 8.1002 3 8.63498 3.27248C9.10538 3.51217 9.48783 3.89462 9.72752 4.36502C10 4.8998 10 5.59987 10 7V17C10 18.4001 10 19.1002 9.72752 19.635C9.48783 20.1054 9.10538 20.4878 8.63498 20.7275C8.1002 21 7.40013 21 6 21C4.59987 21 3.8998 21 3.36502 20.7275C2.89462 20.4878 2.51217 20.1054 2.27248 19.635C2 19.1002 2 18.4001 2 17V7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6 17H6.00898"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M2 7H10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M11.4486 8.26843C11.0937 6.93838 10.9163 6.27336 11.0385 5.69599C11.146 5.18812 11.4108 4.72747 11.7951 4.38005C12.2319 3.98508 12.8942 3.80689 14.2187 3.4505C15.5432 3.09412 16.2055 2.91593 16.7804 3.03865C17.2862 3.1466 17.7449 3.41256 18.0909 3.79841C18.4842 4.23706 18.6617 4.90209 19.0166 6.23213L21.5514 15.7316C21.9063 17.0616 22.0837 17.7266 21.9615 18.304C21.854 18.8119 21.5892 19.2725 21.2049 19.62C20.7681 20.0149 20.1058 20.1931 18.7813 20.5495C17.4568 20.9059 16.7945 21.0841 16.2196 20.9614C15.7138 20.8534 15.2551 20.5874 14.9091 20.2016C14.5158 19.7629 14.3383 19.0979 13.9834 17.7679L11.4486 8.26843Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.7812 16.6953L17.7899 16.693"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      <Path
        d="M12 8.00019L18.5001 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Notification03Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M20 18.5011L18.349 7.93407C17.8603 4.80601 15.166 2.5 12 2.5C8.83398 2.5 6.13971 4.80601 5.65098 7.93407L4 18.5011"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20 18.5C20 16.8431 16.4183 15.5 12 15.5C7.58172 15.5 4 16.8431 4 18.5C4 20.1569 7.58172 21.5 12 21.5C16.4183 21.5 20 20.1569 20 18.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M13 18.5H11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Archive02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M7 21H16.9999C19.3569 21 20.5354 21 21.2677 20.2678C21.9999 19.5355 21.9999 18.357 21.9999 16C21.9999 13.643 21.9999 12.4645 21.2677 11.7322C20.5354 11 19.3569 11 16.9999 11H7C4.64302 11 3.46453 11 2.7323 11.7322C2.00007 12.4644 2.00005 13.6429 2 15.9999C1.99995 18.357 1.99993 19.5355 2.73217 20.2677C3.4644 21 4.64294 21 7 21Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M4 11C4.00005 9.59977 4.00008 8.89966 4.27263 8.36485C4.5123 7.89455 4.89469 7.51218 5.365 7.27253C5.89981 7 6.59993 7 8.00015 7H16C17.4001 7 18.1002 7 18.635 7.27248C19.1054 7.51217 19.4878 7.89462 19.7275 8.36502C20 8.8998 20 9.59987 20 11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M6 7C6.00004 5.5998 6.00006 4.89969 6.27259 4.3649C6.51227 3.89457 6.89467 3.51218 7.36501 3.27252C7.89981 3 8.59991 3 10.0001 3H14C15.4001 3 16.1002 3 16.635 3.27248C17.1054 3.51217 17.4878 3.89462 17.7275 4.36502C18 4.8998 18 5.59987 18 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M16 15L15.7 15.4C15.1111 16.1851 14.8167 16.5777 14.3944 16.7889C13.9721 17 13.4814 17 12.5 17H11.5C10.5186 17 10.0279 17 9.60557 16.7889C9.18328 16.5777 8.88885 16.1851 8.3 15.4L8 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function InboxIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function StopIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M4 12C4 8.72077 4 7.08116 4.81382 5.91891C5.1149 5.48891 5.48891 5.1149 5.91891 4.81382C7.08116 4 8.72077 4 12 4C15.2792 4 16.9188 4 18.0811 4.81382C18.5111 5.1149 18.8851 5.48891 19.1862 5.91891C20 7.08116 20 8.72077 20 12C20 15.2792 20 16.9188 19.1862 18.0811C18.8851 18.5111 18.5111 18.8851 18.0811 19.1862C16.9188 20 15.2792 20 12 20C8.72077 20 7.08116 20 5.91891 19.1862C5.48891 18.8851 5.1149 18.5111 4.81382 18.0811C4 16.9188 4 15.2792 4 12Z"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Search01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M17 17L21 21"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      <Path
        d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

export function Link01Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M9.14339 10.691L9.35031 10.4841C11.329 8.50532 14.5372 8.50532 16.5159 10.4841C18.4947 12.4628 18.4947 15.671 16.5159 17.6497L13.6497 20.5159C11.671 22.4947 8.46279 22.4947 6.48405 20.5159C4.50532 18.5372 4.50532 15.329 6.48405 13.3503L6.9484 12.886"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M17.0516 11.114L17.5159 10.6497C19.4947 8.67095 19.4947 5.46279 17.5159 3.48405C15.5372 1.50532 12.329 1.50532 10.3503 3.48405L7.48405 6.35031C5.50532 8.32904 5.50532 11.5372 7.48405 13.5159C9.46279 15.4947 12.671 15.4947 14.6497 13.5159L14.8566 13.309"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}

/** Box with an arrow leaving it — "open in the phone's browser" (hugeicons link-square-02). */
export function LinkSquare02Icon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <Path
        d="M11.1002 3C7.45057 3.00657 5.53942 3.09617 4.31806 4.31756C3 5.63563 3 7.75696 3 11.9996C3 16.2423 3 18.3636 4.31806 19.6817C5.63611 20.9997 7.75743 20.9997 12.0001 20.9997C16.2427 20.9997 18.3641 20.9997 19.6821 19.6817C20.9035 18.4603 20.9931 16.5492 20.9997 12.8996"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <Path
        d="M20.5561 3.49637L11.0488 13.0026M20.5561 3.49637C20.0621 3.00176 16.7335 3.04785 16.03 3.05786M20.5561 3.49637C21.0501 3.99098 21.004 7.32371 20.994 8.02807"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </IconBase>
  )
}
