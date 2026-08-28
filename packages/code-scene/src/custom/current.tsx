import { makeScene2D, Node, Rect, Txt, Circle, Video } from '@revideo/2d';
import { all, chain, createRef, waitFor, easeInOutSine } from '@revideo/core';
import { spring, SmoothSpring, PlopSpring } from '@revideo/core/lib/tweening/spring';
import { FONT } from '../components';

export default function makeScene(params: any) {
  const W = 1080, H = 1920;
  return makeScene2D('custom', function* (view) {
    view.fill('#7EC8E3');
    const root = createRef<Node>();
    view.add(<Node ref={root} />);

    const bgRoot = createRef<Node>();
    root().add(<Node ref={bgRoot} opacity={0} />);

    bgRoot().add(<Rect width={W} height={H} fill={'#7EC8E3'} />);

    const cloudGroup = createRef<Node>();
    bgRoot().add(<Node ref={cloudGroup} x={-30} />);

    cloudGroup().add(<Circle x={-480} y={-760} width={240} height={130} fill={'#F7F2E7'} opacity={0.85} />);
    cloudGroup().add(<Circle x={-420} y={-790} width={180} height={105} fill={'#F7F2E7'} opacity={0.9} />);
    cloudGroup().add(<Circle x={-370} y={-750} width={200} height={95} fill={'#F7F2E7'} opacity={0.8} />);
    cloudGroup().add(<Circle x={-540} y={-730} width={180} height={90} fill={'#F7F2E7'} opacity={0.8} />);

    cloudGroup().add(<Circle x={330} y={-680} width={220} height={120} fill={'#F7F2E7'} opacity={0.85} />);
    cloudGroup().add(<Circle x={400} y={-710} width={160} height={90} fill={'#F7F2E7'} opacity={0.9} />);
    cloudGroup().add(<Circle x={260} y={-665} width={180} height={85} fill={'#F7F2E7'} opacity={0.8} />);

    cloudGroup().add(<Circle x={-40} y={-870} width={260} height={140} fill={'#F7F2E7'} opacity={0.6} />);
    cloudGroup().add(<Circle x={30} y={-900} width={200} height={110} fill={'#F7F2E7'} opacity={0.7} />);
    cloudGroup().add(<Circle x={-120} y={-850} width={180} height={90} fill={'#F7F2E7'} opacity={0.65} />);

    const vegGroup = createRef<Node>();
    bgRoot().add(<Node ref={vegGroup} />);

    vegGroup().add(<Circle x={-620} y={940} width={1500} height={700} fill={'#A8C69F'} opacity={0.7} />);
    vegGroup().add(<Circle x={640} y={960} width={1600} height={760} fill={'#A8C69F'} opacity={0.8} />);
    vegGroup().add(<Circle x={-40} y={990} width={1700} height={820} fill={'#A8C69F'} opacity={0.9} />);
    vegGroup().add(<Circle x={520} y={1020} width={1300} height={620} fill={'#A8C69F'} opacity={0.65} />);
    vegGroup().add(<Circle x={-520} y={1050} width={1200} height={560} fill={'#A8C69F'} opacity={0.6} />);

    const kickerRef = createRef<Txt>();
    root().add(<Txt ref={kickerRef} text={params.kicker ?? ''} fontFamily={FONT} fontSize={30} fontWeight={500} fill={'#3F3F3F'} y={-840} width={840} textAlign={'center'} opacity={0} />);

    const titleRef = createRef<Txt>();
    root().add(<Txt ref={titleRef} text={params.title ?? ''} fontFamily={FONT} fontSize={64} fontWeight={700} fill={'#3F3F3F'} y={-786} maxWidth={900} textAlign={'center'} opacity={0} />);

    const videoPanel = createRef<Rect>();
    root().add(
      <Rect ref={videoPanel} width={960} height={540} radius={28} y={-100}
        fill={'rgba(247,242,231,0.35)'}
        shadowColor={'#3F3F3F'} shadowBlur={40}
        opacity={0} />,
    );

    if (params.videoSrc) {
      videoPanel().add(
        <Video src={params.videoSrc} width={960} height={540} radius={28} />,
      );
    } else {
      videoPanel().add(
        <Txt text={'▶'} fontFamily={FONT} fontSize={90} fill={'#F7F2E7'} />,
      );
    }

    const subCnRef = createRef<Txt>();
    root().add(<Txt ref={subCnRef} text={params.subtitleCn ?? ''} fontFamily={FONT} fontSize={40} fontWeight={400} fill={'#3F3F3F'} y={765} maxWidth={880} textAlign={'center'} opacity={0} />);

    const subEnRef = createRef<Txt>();
    root().add(<Txt ref={subEnRef} text={params.subtitleEn ?? ''} fontFamily={FONT} fontSize={26} fontWeight={300} fill={'#3F3F3F'} y={815} maxWidth={880} textAlign={'center'} opacity={0} />);

    yield* all(
      spring(SmoothSpring, 0, 1, 0.01, (v) => {
        bgRoot().opacity(v);
      }),
      chain(waitFor(0.2), spring(SmoothSpring, 0, 1, 0.01, (v) => {
        kickerRef().opacity(v);
        kickerRef().y(-840 + 20 * (1 - v));
      })),
      chain(waitFor(0.35), spring(SmoothSpring, 0, 1, 0.01, (v) => {
        titleRef().opacity(v);
        titleRef().y(-786 + 20 * (1 - v));
      })),
      chain(waitFor(0.5), spring(PlopSpring, 0, 1, 0.01, (v) => {
        videoPanel().opacity(Math.min(1, v * 1.5));
        videoPanel().scale(0.94 + 0.06 * v);
      })),
      chain(waitFor(0.8), spring(SmoothSpring, 0, 1, 0.01, (v) => {
        subCnRef().opacity(v);
        subCnRef().y(765 + 20 * (1 - v));
        subEnRef().opacity(v);
        subEnRef().y(815 + 20 * (1 - v));
      })),
    );

    const total = params.duration ?? 5;
    const remaining = Math.max(0, total - 1.2);
    const cloudCycles = Math.max(1, Math.ceil(remaining / 6));
    const vegCycles = Math.max(1, Math.ceil(remaining / 6));
    const shadowCycles = Math.max(1, Math.ceil(remaining / 4));

    function* cloudLoop() {
      for (let i = 0; i < cloudCycles; i++) {
        yield* cloudGroup().x(30, 3, easeInOutSine);
        yield* cloudGroup().x(-30, 3, easeInOutSine);
      }
    }
    function* vegLoop() {
      for (let i = 0; i < vegCycles; i++) {
        yield* vegGroup().scale(1.02, 3, easeInOutSine);
        yield* vegGroup().scale(1, 3, easeInOutSine);
      }
    }
    function* shadowLoop() {
      for (let i = 0; i < shadowCycles; i++) {
        yield* videoPanel().shadowBlur(70, 2, easeInOutSine);
        yield* videoPanel().shadowBlur(40, 2, easeInOutSine);
      }
    }

    yield* all(cloudLoop(), vegLoop(), shadowLoop());
  });
}