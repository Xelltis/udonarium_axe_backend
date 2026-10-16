import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import ChooseFlow from './components/ChooseFlow.vue';
import DeployMap from './components/DeployMap.vue';
import FtpPanes from './components/FtpPanes.vue';
import Journey from './components/Journey.vue';
import LoginFlow from './components/LoginFlow.vue';
import ModeCompare from './components/ModeCompare.vue';
import MutualLink from './components/MutualLink.vue';
import OriginAnatomy from './components/OriginAnatomy.vue';
import StepFlow from './components/StepFlow.vue';

import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // The drawings the pages use, written as components so that they follow the light and dark
    // themes and lay themselves out again on a narrow screen.
    app.component('ChooseFlow', ChooseFlow);
    app.component('DeployMap', DeployMap);
    app.component('FtpPanes', FtpPanes);
    app.component('Journey', Journey);
    app.component('LoginFlow', LoginFlow);
    app.component('ModeCompare', ModeCompare);
    app.component('MutualLink', MutualLink);
    app.component('OriginAnatomy', OriginAnatomy);
    app.component('StepFlow', StepFlow);
  },
} satisfies Theme;
