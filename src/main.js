import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Color3,
  Color4,
  SceneLoader,
  MeshBuilder,
  StandardMaterial,
  ShadowGenerator,
  Animation,
  CubicEase,
  EasingFunction,
  WebXRFeatureName,
  PointerDragBehavior,
  CubeTexture,
  DynamicTexture,
  Texture,
  PBRMaterial,
  DefaultRenderingPipeline,
  SSAO2RenderingPipeline
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import {
  AdvancedDynamicTexture,
  Button,
  Slider,
  TextBlock,
  StackPanel,
  Rectangle
} from "@babylonjs/gui";

// =========================================================
// CONFIGURAÇÃO — ajuste aqui conforme o seu modelo
// =========================================================
const CONFIG = {
  modelFile: "torno.glb",
  // caminho relativo (sem "/" na frente) — funciona tanto local
  // quanto hospedado em subpasta, como no GitHub Pages
  modelPath: "models/",
  distanciaExplosaoPadrao: 0.6,
  // este modelo NÃO tem peças nomeadas (é uma única malha combinada
  // com 31 materiais genéricos "defaultplastic", cada um com cor
  // diferente). Por isso a detecção de "peça pequena" é feita pelo
  // TAMANHO relativo de cada peça, não por palavra-chave no nome.
  limiarPecaPequena: 0.12, // peça com diagonal < 12% da diagonal total
  multiplicadorPecaPequena: 2.5,
  // rotação/escala aplicadas ao container-pivô — ainda não calibradas
  // pra este modelo. Ajuste ao vivo no console (ver dicas no final
  // do carregamento) e depois fixe os valores aqui.
  correcaoRotacao: { x: 0, y: 0, z: 0 },
  escala: 1,
  // caminho relativo do PDF do manual do operador
  manualPdf: "manual/manual-operador.pdf",
  // personagem local (convertido de FBX) — NÃO usa mais CDN externa
  personagemArquivo: "pessoa.glb"
};

// =========================================================
// SETUP BÁSICO DA CENA
// =========================================================
const canvas = document.getElementById("renderCanvas");
const engine = new Engine(canvas, true, { stencil: true, antialias: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.13, 0.14, 0.17, 1);

const camera = new ArcRotateCamera(
  "camera",
  -Math.PI / 2.5,
  Math.PI / 2.5,
  4,
  Vector3.Zero(),
  scene
);
camera.attachControl(canvas, true);
camera.lowerRadiusLimit = 0.5;
camera.upperRadiusLimit = 40;
camera.wheelPrecision = 50;

// -----------------------------------------------------------
// ILUMINAÇÃO
// -----------------------------------------------------------
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.55;
hemi.diffuse = new Color3(1, 1, 1);
hemi.groundColor = new Color3(0.3, 0.3, 0.34);

const dir = new DirectionalLight("dir", new Vector3(-0.6, -1.6, -0.8), scene);
dir.intensity = 0.85;
dir.position = new Vector3(6, 12, 6);
dir.diffuse = new Color3(1, 1, 1);

const fill = new DirectionalLight("fill", new Vector3(0.8, -1, 0.9), scene);
fill.intensity = 0.25;
fill.diffuse = new Color3(1, 1, 1);
fill.specular = new Color3(0, 0, 0);

const shadowGenerator = new ShadowGenerator(512, dir);
shadowGenerator.usePercentageCloserFiltering = true;
shadowGenerator.darkness = 0.55;

scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(
  "https://assets.babylonjs.com/environments/environmentSpecular.env",
  scene
);
scene.environmentIntensity = 0.35;

scene.imageProcessingConfiguration.exposure = 0.95;
scene.imageProcessingConfiguration.contrast = 1.05;

// -----------------------------------------------------------
// RENDERIZAÇÃO ESTILO VIEWPORT CAD (SolidWorks RealView / Inventor)
// SSAO (sombreamento de contato) + anti-aliasing + leve bloom/nitidez.
// Desliga sozinho ao entrar em RV/RA pra não pesar no Quest.
// -----------------------------------------------------------
let ssaoPipeline = null;
let defaultPipeline = null;

function configurarRenderizacaoRealista() {
  ssaoPipeline = new SSAO2RenderingPipeline("ssao", scene, 0.5, [camera]);
  ssaoPipeline.radius = 1;
  ssaoPipeline.totalStrength = 0.7;
  ssaoPipeline.expensiveBlur = false;
  ssaoPipeline.samples = 8;

  defaultPipeline = new DefaultRenderingPipeline("padrao", true, scene, [camera]);
  defaultPipeline.samples = 2;
  defaultPipeline.fxaaEnabled = true;
  defaultPipeline.bloomEnabled = true;
  defaultPipeline.bloomThreshold = 0.85;
  defaultPipeline.bloomWeight = 0.12;
  defaultPipeline.bloomKernel = 48;
  defaultPipeline.sharpenEnabled = true;
  defaultPipeline.sharpen.edgeAmount = 0.25;
}

function ativarRenderizacaoRealista(ativo) {
  if (ssaoPipeline) ssaoPipeline.isEnabled = ativo;
  if (defaultPipeline) {
    defaultPipeline.bloomEnabled = ativo;
    defaultPipeline.sharpenEnabled = ativo;
    defaultPipeline.fxaaEnabled = ativo;
  }
  // sombras dinâmicas são um dos itens mais caros pra GPU do Quest —
  // desliga completamente em RV/RA, volta no desktop
  scene.shadowsEnabled = ativo;
}

configurarRenderizacaoRealista();
window.desligarSSAO = () => { if (ssaoPipeline) ssaoPipeline.isEnabled = false; console.log("SSAO desligado."); };
window.ligarSSAO = () => { if (ssaoPipeline) ssaoPipeline.isEnabled = true; console.log("SSAO ligado."); };
window.desligarSombras = () => { scene.shadowsEnabled = false; console.log("Sombras desligadas."); };
window.ligarSombras = () => { scene.shadowsEnabled = true; console.log("Sombras ligadas."); };

// =========================================================
// ESTADO GLOBAL
// =========================================================
let containerMaquina = null;
let partes = [];
let dadosExplosao = [];
let fatorExplosaoAtual = 0;
let modoAtual = "livre";
let dragBehaviors = [];
let xrHelper = null;
let painelControleXR = null;
let chao = null;

// =========================================================
// UTILITÁRIO — bounding box de um conjunto de meshes
// =========================================================
function calcularBoundingBox(listaPartes) {
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  listaPartes.forEach((p) => {
    const bb = p.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  });
  return { min, max, centro: min.add(max).scale(0.5), tamanho: max.subtract(min) };
}

const splash = document.getElementById("splash");
const splashProgressBar = document.getElementById("splash-progress-bar");
const splashProgressLabel = document.getElementById("splash-progress-label");
const btnIniciar = document.getElementById("btn-iniciar");

function atualizarProgressoSplash(evento) {
  if (evento.lengthComputable && evento.total > 0) {
    const pct = Math.min(100, Math.round((evento.loaded / evento.total) * 100));
    splashProgressBar.style.width = `${pct}%`;
    splashProgressLabel.textContent = `Carregando modelo... ${pct}%`;
  } else {
    const mb = (evento.loaded / (1024 * 1024)).toFixed(1);
    splashProgressLabel.textContent = `Carregando modelo... ${mb} MB`;
  }
}

function liberarBotaoIniciar() {
  splashProgressBar.style.width = "100%";
  splashProgressLabel.textContent = "Pronto!";
  btnIniciar.disabled = false;
  btnIniciar.textContent = "Iniciar Simulação";
}

btnIniciar.addEventListener("click", () => {
  splash.classList.add("hidden");
});

// =========================================================
// CARREGAMENTO E CORREÇÃO DO MODELO
// =========================================================
async function carregarModelo() {
  try {
    // este GLB específico traz câmeras e luzes de exportação (views
    // predefinidas do 3ds Max, tipo "Front"/"Top"/"Isometric" + 2
    // luzes direcionais) que NÃO são nossas — guarda o que já existia
    // antes do import pra descartar o que sobrar depois
    const camerasAntes = new Set(scene.cameras);
    const lightsAntes = new Set(scene.lights);

    const result = await SceneLoader.ImportMeshAsync(
      "",
      CONFIG.modelPath,
      CONFIG.modelFile,
      scene,
      atualizarProgressoSplash
    );

    // descarta câmeras/luzes que vieram do arquivo, mantém só as nossas
    scene.cameras.slice().forEach((c) => { if (!camerasAntes.has(c)) c.dispose(); });
    scene.lights.slice().forEach((l) => { if (!lightsAntes.has(l)) l.dispose(); });
    scene.activeCamera = camera;
    camera.attachControl(canvas, true);

    // Container vazio (invisível) que serve de pivô estrutural pra máquina
    containerMaquina = MeshBuilder.CreateBox("containerMaquina", { size: 0.1 }, scene);
    containerMaquina.isVisible = false;

    // Partes físicas reais do modelo
    partes = result.meshes.filter((m) => m.getTotalVertices() > 0 && m !== containerMaquina);

    // Move o nó importado original para dentro do container
    result.meshes[0].setParent(containerMaquina);

    // Rotaciona e escala o container como um todo — a montagem interna fica intacta
    containerMaquina.rotation.x = CONFIG.correcaoRotacao.x;
    containerMaquina.rotation.y = CONFIG.correcaoRotacao.y;
    containerMaquina.rotation.z = CONFIG.correcaoRotacao.z;
    containerMaquina.scaling.setAll(CONFIG.escala);
    scene.incrementRenderId();
    containerMaquina.computeWorldMatrix(true);
    partes.forEach((p) => p.computeWorldMatrix(true));

    // Assenta a base da máquina em Y = 0
    let bbox = calcularBoundingBox(partes);
    containerMaquina.position.y -= bbox.min.y;
    scene.incrementRenderId();
    containerMaquina.computeWorldMatrix(true);
    partes.forEach((p) => p.computeWorldMatrix(true));

    partes.forEach((mesh) => {
      shadowGenerator.addShadowCaster(mesh);
      mesh.receiveShadows = true;
    });

    bbox = calcularBoundingBox(partes);
    construirCenario(bbox);
    enquadrarCamera(bbox);
    aplicarAcabamentoPolido(partes);
    adicionarPersonagemAnimado(bbox); // não bloqueia o carregamento se falhar

    dadosExplosao = prepararExplosao(partes);
    prepararModoLivre();

    // ---- atalhos de debug: orientação e escala ainda não calibradas ----
    // no console do navegador (F12):
    //   ajustarRotacaoGraus(90, 0, 0)   -> gira em graus, um eixo por vez
    //   ajustarEscala(1.5)              -> aumenta/diminui o tamanho
    window.ajustarRotacaoGraus = (xg = 0, yg = 0, zg = 0) => {
      containerMaquina.rotation.set((xg * Math.PI) / 180, (yg * Math.PI) / 180, (zg * Math.PI) / 180);
      containerMaquina.computeWorldMatrix(true);
      partes.forEach((p) => p.computeWorldMatrix(true));
      const nova = calcularBoundingBox(partes);
      containerMaquina.position.y -= nova.min.y;
      containerMaquina.computeWorldMatrix(true);
      enquadrarCamera(calcularBoundingBox(partes));
      console.log(`Rotação: x=${xg}° y=${yg}° z=${zg}°`);
    };
    window.ajustarEscala = (fator = 1) => {
      containerMaquina.scaling.setAll(fator);
      containerMaquina.computeWorldMatrix(true);
      partes.forEach((p) => p.computeWorldMatrix(true));
      const nova = calcularBoundingBox(partes);
      containerMaquina.position.y -= nova.min.y;
      containerMaquina.computeWorldMatrix(true);
      enquadrarCamera(calcularBoundingBox(partes));
      console.log(`Escala: ${fator}x`);
    };
    console.log(
      "%cDica: ajustarRotacaoGraus(x,y,z) e ajustarEscala(fator) no console pra calibrar sem rebuild.",
      "color:#4fd1c5"
    );

    liberarBotaoIniciar();
    console.log(`Modelo carregado com sucesso: ${partes.length} peças organizadas.`);
  } catch (err) {
    console.error("Erro ao carregar modelo:", err);
    splashProgressLabel.textContent = "Erro ao carregar modelo.";
  }
}

function enquadrarCamera(bbox) {
  const tamanho = bbox.tamanho.length();
  camera.setTarget(bbox.centro);
  camera.radius = Math.max(tamanho * 1.7, 2);
}

// =========================================================
// CENÁRIO — Estilo SENAI São Carlos
// =========================================================
function criarTexturaPisoEpoxi(repeticoes) {
  const tex = new DynamicTexture("texPiso", { width: 512, height: 512 }, scene, true);
  const ctx = tex.getContext();
  // tom cinza platina de piso epóxi de laboratório industrial
  ctx.fillStyle = "#c3c5cb";
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(60, 63, 70, 0.22)";
  ctx.lineWidth = 2;
  const passo = 64;
  for (let i = 0; i <= 512; i += passo) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.uScale = repeticoes;
  tex.vScale = repeticoes;
  return tex;
}

function criarTexturaParedeClara() {
  const tex = new DynamicTexture("texParedeClara", { width: 512, height: 512 }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#e8e9eb";
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(140, 145, 155, 0.35)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke(); }
  for (let i = 0; i <= 512; i += 256) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke(); }
  ctx.fillStyle = "#c7cad0";
  ctx.fillRect(0, 460, 512, 52);
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

function criarPainelSenai(largura, altura) {
  const tex = new DynamicTexture("texSenai", { width: 1024, height: 512 }, scene, true);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, 1024, 512);
  ctx.fillStyle = "#f0501e"; // laranja SENAI
  ctx.textAlign = "center";
  ctx.font = "bold 190px Arial";
  ctx.fillText("SENAI", 512, 260);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px Arial";
  ctx.fillText("Escola SENAI Antonio Adolphe Lobbe", 512, 330);
  ctx.font = "24px Arial";
  ctx.fillStyle = "#cfd6de";
  ctx.fillText("São Carlos/SP — Laboratório de Mecatrônica", 512, 368);
  tex.update();
  tex.hasAlpha = true;

  const mat = new StandardMaterial("matSenai", scene);
  mat.diffuseTexture = tex;
  mat.diffuseTexture.hasAlpha = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.emissiveTexture = tex;
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false;
  const plane = MeshBuilder.CreatePlane("painelSenai", { width: largura, height: altura * 0.5 }, scene);
  plane.material = mat;
  return plane;
}

function criarJanela(largura, altura) {
  const tex = new DynamicTexture("texJanela", { width: 256, height: 256 }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#a9d4e0";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, 246, 246);
  ctx.beginPath(); ctx.moveTo(128, 0); ctx.lineTo(128, 256); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 128); ctx.lineTo(256, 128); ctx.stroke();
  tex.update();

  const mat = new StandardMaterial("matJanela", scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = new Color3(0.6, 0.6, 0.6);
  mat.specularColor = Color3.Black();
  const plane = MeshBuilder.CreatePlane("janela", { width: largura, height: altura }, scene);
  plane.material = mat;
  return plane;
}

function criarLuzesTeto(y, largura, quantidade, profundidadeSala) {
  const mat = new StandardMaterial("matLuzTeto", scene);
  mat.emissiveColor = new Color3(1, 1, 0.97);
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();

  const linhasZ = [-profundidadeSala * 0.25, profundidadeSala * 0.25];
  linhasZ.forEach((z, linha) => {
    const espaco = largura / quantidade;
    for (let i = 0; i < quantidade; i++) {
      const luz = MeshBuilder.CreateBox(
        `luzTeto${linha}_${i}`,
        { width: espaco * 0.7, height: 0.05, depth: 0.25 },
        scene
      );
      luz.material = mat;
      luz.position = new Vector3((i - (quantidade - 1) / 2) * espaco, y, z);
    }
  });
}

// =========================================================
// PAINEL DE CONTROLE 3D — os mesmos botões do HUD, mas
// existindo DENTRO da cena, pra funcionar de óculos posto.
// Fica fixo perto da máquina, apontável com o controle do Quest.
// =========================================================
function criarPainelControleXR(bbox, tamanhoMaquina) {
  const largura = Math.max(tamanhoMaquina * 0.55, 0.7);
  const altura = largura * 0.7;

  const placaBase = MeshBuilder.CreatePlane(
    "painelControleXR",
    { width: largura, height: altura },
    scene
  );
  placaBase.position = new Vector3(
    bbox.min.x - tamanhoMaquina * 0.15,
    bbox.min.y + tamanhoMaquina * 0.35,
    bbox.centro.z
  );
  placaBase.rotation.y = Math.PI / 2;
  // some por padrão — só aparece quando a sessão XR entrar em modo RV
  // (ver onStateChangedObservable em configurarXR)
  placaBase.setEnabled(false);
  painelControleXR = placaBase;

  const adt = AdvancedDynamicTexture.CreateForMesh(placaBase, 512, 358, false);

  const fundo = new Rectangle("fundoPainel");
  fundo.width = 1;
  fundo.height = 1;
  fundo.background = "#161a22ee";
  fundo.thickness = 2;
  fundo.color = "#4fd1c5";
  fundo.cornerRadius = 16;
  adt.addControl(fundo);

  const pilha = new StackPanel("pilhaPainel");
  pilha.width = 0.92;
  pilha.paddingTop = "18px";
  fundo.addControl(pilha);

  const titulo = new TextBlock("tituloPainel", "TORNO CNC — Controle");
  titulo.height = "40px";
  titulo.color = "#e8ecf1";
  titulo.fontSize = 30;
  titulo.fontWeight = "bold";
  pilha.addControl(titulo);

  const linhaModos = new StackPanel("linhaModos");
  linhaModos.isVertical = false;
  linhaModos.height = "70px";
  linhaModos.paddingTop = "14px";
  pilha.addControl(linhaModos);

  function criarBotaoXR(texto, largura, aoClicar) {
    const btn = Button.CreateSimpleButton(`btnXR_${texto}`, texto);
    btn.width = largura;
    btn.height = "56px";
    btn.color = "#e8ecf1";
    btn.fontSize = 24;
    btn.background = "#2a2f3a";
    btn.cornerRadius = 10;
    btn.thickness = 0;
    btn.paddingLeft = "6px";
    btn.paddingRight = "6px";
    btn.onPointerUpObservable.add(aoClicar);
    return btn;
  }

  const btnLivreXR = criarBotaoXR("Livre", "160px", () => {
    setModo("livre");
    atualizarEstiloBotoesXR();
  });
  const btnExplodidoXR = criarBotaoXR("Explodido", "220px", () => {
    setModo("explodido");
    atualizarEstiloBotoesXR();
  });
  linhaModos.addControl(btnLivreXR);
  linhaModos.addControl(btnExplodidoXR);

  function atualizarEstiloBotoesXR() {
    btnLivreXR.background = modoAtual === "livre" ? "#4fd1c5" : "#2a2f3a";
    btnExplodidoXR.background = modoAtual === "explodido" ? "#4fd1c5" : "#2a2f3a";
  }
  atualizarEstiloBotoesXR();

  const rotuloSlider = new TextBlock("rotuloSlider", "Fator de explosão");
  rotuloSlider.height = "30px";
  rotuloSlider.color = "#9aa4b2";
  rotuloSlider.fontSize = 18;
  rotuloSlider.paddingTop = "10px";
  pilha.addControl(rotuloSlider);

  const sliderXR = new Slider("sliderXR");
  sliderXR.minimum = 0;
  sliderXR.maximum = 100;
  sliderXR.value = 0;
  sliderXR.height = "36px";
  sliderXR.width = "88%";
  sliderXR.color = "#4fd1c5";
  sliderXR.background = "#2a2f3a";
  sliderXR.onValueChangedObservable.add((valor) => {
    if (modoAtual !== "explodido") return;
    aplicarExplosao(valor / 100);
    document.getElementById("explode-slider").value = valor;
  });
  pilha.addControl(sliderXR);

  const linhaXR = new StackPanel("linhaXR");
  linhaXR.isVertical = false;
  linhaXR.height = "60px";
  linhaXR.paddingTop = "12px";
  pilha.addControl(linhaXR);

  const btnSairXR = criarBotaoXR("Sair da RV/RA", "220px", () => {
    if (xrHelper) xrHelper.baseExperience.exitXRAsync();
  });
  const btnManualXR = criarBotaoXR("📄 Manual", "160px", () => {
    if (xrHelper) {
      xrHelper.baseExperience.exitXRAsync().then(() => abrirManual());
    }
  });
  linhaXR.addControl(btnSairXR);
  linhaXR.addControl(btnManualXR);

  return placaBase;
}

function construirCenario(bbox) {
  const tamanhoMaquina = Math.max(bbox.tamanho.x, bbox.tamanho.z);
  const alturaMaquina = bbox.tamanho.y;
  const tamanhoPiso = Math.max(tamanhoMaquina * 5, 12);
  const alturaParede = Math.max(alturaMaquina * 2.6, 4);
  const centro = new Vector3(bbox.centro.x, 0, bbox.centro.z);
  const distParede = tamanhoPiso / 2;

  // ---- piso ----
  chao = MeshBuilder.CreateGround("chao", { width: tamanhoPiso, height: tamanhoPiso }, scene);
  chao.position.copyFrom(centro);
  const matPiso = new StandardMaterial("matPiso", scene);
  matPiso.diffuseTexture = criarTexturaPisoEpoxi(tamanhoPiso / 2.2);
  matPiso.specularColor = new Color3(0.1, 0.1, 0.1);
  chao.material = matPiso;
  chao.receiveShadows = true;

  // ---- parede de fundo — azul-marinho, com a logo grande do SENAI ----
  const matParedeNavy = new StandardMaterial("matParedeNavy", scene);
  matParedeNavy.diffuseColor = new Color3(0.05, 0.1, 0.18);
  matParedeNavy.specularColor = Color3.Black();

  const paredeFundo = MeshBuilder.CreatePlane("paredeFundo", { width: tamanhoPiso, height: alturaParede }, scene);
  paredeFundo.material = matParedeNavy;
  paredeFundo.position.set(centro.x, alturaParede / 2, centro.z - distParede);
  paredeFundo.receiveShadows = true;

  const painel = criarPainelSenai(tamanhoMaquina * 2.2, tamanhoMaquina * 0.9);
  // antes ficava grudado na parede de fundo (muito longe, ilegível).
  // agora flutua bem mais perto da máquina/câmera, mantendo o fundo
  // navy da parede como pano de fundo visual atrás dele.
  const distPainel = Math.min(distParede - 0.05, tamanhoMaquina * 1.4);
  painel.position.set(centro.x, alturaParede * 0.55, centro.z - distPainel);

  // ---- paredes laterais claras, com janelas ----
  const texParedeClara = criarTexturaParedeClara();
  const matParedeClara = new StandardMaterial("matParedeClara", scene);
  matParedeClara.diffuseTexture = texParedeClara;
  matParedeClara.specularColor = Color3.Black();

  const paredeEsquerda = MeshBuilder.CreatePlane("paredeEsquerda", { width: tamanhoPiso, height: alturaParede }, scene);
  paredeEsquerda.material = matParedeClara;
  paredeEsquerda.rotation.y = Math.PI / 2;
  paredeEsquerda.position.set(centro.x - distParede, alturaParede / 2, centro.z);
  paredeEsquerda.receiveShadows = true;

  const paredeDireita = MeshBuilder.CreatePlane("paredeDireita", { width: tamanhoPiso, height: alturaParede }, scene);
  paredeDireita.material = matParedeClara;
  paredeDireita.rotation.y = -Math.PI / 2;
  paredeDireita.position.set(centro.x + distParede, alturaParede / 2, centro.z);
  paredeDireita.receiveShadows = true;

  // janelas na parede direita
  const larguraJanela = tamanhoMaquina * 0.4;
  const alturaJanela = alturaParede * 0.3;
  [-0.3, 0.3].forEach((t) => {
    const janela = criarJanela(larguraJanela, alturaJanela);
    janela.rotation.y = -Math.PI / 2;
    janela.position.set(centro.x + distParede - 0.03, alturaParede * 0.6, centro.z + t * tamanhoPiso);
  });

  // ---- iluminação de teto (fluorescente) ----
  criarLuzesTeto(alturaParede * 0.9, tamanhoPiso * 0.7, 4, tamanhoPiso * 0.5);

  criarPainelControleXR(bbox, tamanhoMaquina);
}

// =========================================================
// ACABAMENTO METÁLICO — aumenta metallic/reduz roughness
// para dar efeito de metal polido. NÃO mexe em albedoColor
// (mat.metallic e mat.roughness são as únicas propriedades
// tocadas), então a cor original de cada peça é preservada —
// só o brilho/reflexo muda.
// =========================================================
function aplicarAcabamentoPolido(listaPartes) {
  const materiaisProcessados = new Set();
  const materiaisOriginais = new Map();

  listaPartes.forEach((mesh) => {
    const mat = mesh.material;
    if (!mat || materiaisProcessados.has(mat.uniqueId)) return;
    materiaisProcessados.add(mat.uniqueId);

    if (mat instanceof PBRMaterial) {
      const metallicOriginal = typeof mat.metallic === "number" ? mat.metallic : 0;
      const roughnessOriginal = typeof mat.roughness === "number" ? mat.roughness : 1;
      materiaisOriginais.set(mat.uniqueId, { metallic: metallicOriginal, roughness: roughnessOriginal });
    }
  });

  materiaisProcessados.clear();
  listaPartes.forEach((mesh) => {
    const mat = mesh.material;
    if (!mat || materiaisProcessados.has(mat.uniqueId)) return;
    materiaisProcessados.add(mat.uniqueId);

    if (mat instanceof PBRMaterial) {
      // ajuste PROPORCIONAL ao material original, não um valor fixo
      // pra tudo — assim uma peça que já era plástico fosco (metallic
      // baixo, roughness alto) continua parecendo plástico, só um
      // pouco mais definida, enquanto peças já metálicas (ex: spindle)
      // ganham destaque de verdade. Isso evita que porta/carenagem
      // pintada fiquem brilhando igual metal polido.
      const original = materiaisOriginais.get(mat.uniqueId);
      mat.metallic = Math.min(1, original.metallic + 0.25);
      mat.roughness = Math.max(0.05, original.roughness - 0.15);
      // albedoColor não é tocado — cor original preservada
    } else if (mat.specularColor) {
      // fallback pra StandardMaterial
      mat.specularColor = new Color3(0.5, 0.5, 0.5);
      mat.specularPower = 128;
    }
  });

  console.log(`Acabamento metálico aplicado em ${materiaisProcessados.size} materiais.`);

  // atalho de debug pra ajustar ao vivo sem rebuild
  window.ajustarAcabamento = (bumpMetallic = 0.25, reducaoRoughness = 0.15) => {
    materiaisProcessados.clear();
    listaPartes.forEach((mesh) => {
      const mat = mesh.material;
      if (!mat || materiaisProcessados.has(mat.uniqueId)) return;
      materiaisProcessados.add(mat.uniqueId);
      if (mat instanceof PBRMaterial) {
        // recalcula sempre a partir do valor ORIGINAL guardado, não
        // do valor já modificado — senão os ajustes se acumulam
        const original = materiaisOriginais.get(mat.uniqueId);
        if (!original) return;
        mat.metallic = Math.min(1, original.metallic + bumpMetallic);
        mat.roughness = Math.max(0.05, original.roughness - reducaoRoughness);
      }
    });
    console.log(`Acabamento ajustado: +metallic=${bumpMetallic} -roughness=${reducaoRoughness}`);
  };
  window.ajustarAmbiente = (intensidade = 0.3) => {
    scene.environmentIntensity = intensidade;
    console.log(`Intensidade do ambiente refletido: ${intensidade}`);
  };
  console.log(
    "%cDica: ajustarAcabamento(metallic, roughness) e ajustarAmbiente(intensidade) no console pra afinar sem rebuild.",
    "color:#4fd1c5"
  );
}

// =========================================================
// PERSONAGEM ANIMADO — operador de referência de escala,
// parado ao lado da máquina. Carrega um GLB LOCAL (convertido
// de FBX, ex: Mixamo), em vez da CDN pública usada nos projetos
// anteriores — assim funciona offline e com um personagem
// customizado. Não bloqueia o carregamento da máquina se o
// arquivo faltar ou der erro — roda em paralelo, com try/catch
// próprio (útil também enquanto o pessoa.glb ainda não existir
// em public/models/).
// =========================================================
async function adicionarPersonagemAnimado(bbox) {
  try {
    const result = await SceneLoader.ImportMeshAsync(
      "",
      CONFIG.modelPath,
      CONFIG.personagemArquivo,
      scene
    );
    const personagem = result.meshes[0];
    result.meshes.forEach((m) => {
      if (m.getTotalVertices() > 0) {
        shadowGenerator.addShadowCaster(m);
        m.receiveShadows = true;
      }
    });

    // escala pra altura humana real (~1,7m), medindo o tamanho
    // NATIVO do próprio personagem — bem mais confiável do que
    // estimar a partir do tamanho da máquina (a fórmula anterior
    // tinha sido copiada do projeto da moenda, que usava uma
    // escala de exibição diferente, e encolhia demais o personagem
    // aqui). O × CONFIG.escala mantém a proporção caso a máquina
    // também esteja ampliada por exibição (ver CONFIG.escala).
    const partesPersonagem = result.meshes.filter((m) => m.getTotalVertices() > 0);
    partesPersonagem.forEach((m) => m.computeWorldMatrix(true));
    const bboxPersonagemNativo = calcularBoundingBox(partesPersonagem);
    const alturaNativaPersonagem = bboxPersonagemNativo.tamanho.y || 1;
    const alturaAlvo = 1.7 * CONFIG.escala;
    const fatorEscala = alturaAlvo / alturaNativaPersonagem;
    personagem.scaling.setAll(fatorEscala);

    // posiciona ao lado da máquina, no chão
    personagem.position = new Vector3(
      bbox.centro.x + bbox.tamanho.x * 0.75,
      0,
      bbox.centro.z
    );

    // não sabemos de antemão o nome do grupo de animação desse
    // personagem específico (varia conforme a animação escolhida
    // no Mixamo) — pega o primeiro grupo disponível automaticamente
    if (scene.animationGroups.length > 0) {
      const animacao = scene.animationGroups[0];
      animacao.start(true, 1.0, animacao.from, animacao.to, false);
      console.log(`Personagem animado com o grupo "${animacao.name}" (${scene.animationGroups.length} disponível(is)).`);
    } else {
      console.warn("Personagem carregado, mas sem grupos de animação (modelo estático ou sem rig).");
    }

    // atalhos de debug pra reposicionar/redimensionar/trocar animação ao vivo
    window.personagem = personagem;
    window.moverPersonagem = (x, y, z) => {
      personagem.position.set(x, y, z);
      console.log(`Personagem movido para: x=${x} y=${y} z=${z}`);
    };
    window.escalarPersonagem = (fator) => {
      personagem.scaling.setAll(fator);
      console.log(`Personagem escalado para: ${fator}`);
    };
    window.trocarAnimacaoPersonagem = (nomeOuIndice) => {
      scene.animationGroups.forEach((g) => g.stop());
      const grupo = typeof nomeOuIndice === "number"
        ? scene.animationGroups[nomeOuIndice]
        : scene.getAnimationGroupByName(nomeOuIndice);
      if (!grupo) {
        console.warn("Grupo de animação não encontrado. Disponíveis:", scene.animationGroups.map((g) => g.name));
        return;
      }
      grupo.start(true, 1.0, grupo.from, grupo.to, false);
      console.log(`Tocando animação: ${grupo.name}`);
    };
    console.log(
      "%cDica: moverPersonagem(x,y,z), escalarPersonagem(fator) e trocarAnimacaoPersonagem(nomeOuIndice) no console.",
      "color:#4fd1c5"
    );
  } catch (err) {
    console.warn(
      `Personagem não carregado (${CONFIG.personagemArquivo} ausente ou com erro) — isso é esperado até o arquivo ser adicionado em public/models/.`,
      err.message || err
    );
  }
}

function prepararExplosao(listaPartes) {
  const bbox = calcularBoundingBox(listaPartes);
  const centroGeral = bbox.centro;
  const diagonalTotal = bbox.tamanho.length();

  return listaPartes.map((mesh) => {
    const posicaoOriginal = mesh.position.clone();

    const bb = mesh.getBoundingInfo().boundingBox;
    const centroPeca = bb.minimumWorld.add(bb.maximumWorld).scale(0.5);
    let direcao = centroPeca.subtract(centroGeral);

    if (direcao.length() < 0.0001) {
      direcao = new Vector3(0, 1, 0);
    }
    direcao.normalize();

    // Transforma a direção do mundo para o espaço local do container
    const direcaoLocal = Vector3.TransformNormal(direcao, containerMaquina.getWorldMatrix().invert());
    direcaoLocal.normalize();

    // este modelo não tem nomes de peça — detecta "peça pequena"
    // pelo TAMANHO relativo (diagonal da própria peça vs. diagonal
    // total da máquina), em vez de palavra-chave no nome
    const diagonalPeca = bb.maximumWorld.subtract(bb.minimumWorld).length();
    const ehPecaPequena = diagonalTotal > 0 && diagonalPeca / diagonalTotal < CONFIG.limiarPecaPequena;
    const distancia = ehPecaPequena
      ? CONFIG.distanciaExplosaoPadrao * CONFIG.multiplicadorPecaPequena
      : CONFIG.distanciaExplosaoPadrao;

    return {
      mesh,
      posicaoOriginal,
      direcao: direcaoLocal,
      distancia
    };
  });
}

function aplicarExplosao(fator) {
  fatorExplosaoAtual = fator;
  dadosExplosao.forEach(({ mesh, posicaoOriginal, direcao, distancia }) => {
    mesh.position = posicaoOriginal.add(direcao.scale(fator * distancia));
  });
}

function animarExplosaoPara(fatorAlvo, duracaoFrames = 30) {
  const easing = new CubicEase();
  easing.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);

  const anim = new Animation(
    "explodeAnim",
    "_fatorExplosao",
    30,
    Animation.ANIMATIONTYPE_FLOAT,
    Animation.ANIMATIONLOOPMODE_CONSTANT
  );
  anim.setEasingFunction(easing);
  anim.setKeys([
    { frame: 0, value: fatorExplosaoAtual },
    { frame: duracaoFrames, value: fatorAlvo }
  ]);

  const proxy = { _fatorExplosao: fatorExplosaoAtual };
  scene.beginDirectAnimation(proxy, [anim], 0, duracaoFrames, false, 1, () => {
    aplicarExplosao(fatorAlvo);
  });

  const observer = scene.onBeforeRenderObservable.add(() => {
    aplicarExplosao(proxy._fatorExplosao);
    if (Math.abs(proxy._fatorExplosao - fatorAlvo) < 0.001) {
      scene.onBeforeRenderObservable.remove(observer);
    }
  });
}

// =========================================================
// MODO LIVRE — arrastar peças manualmente
// =========================================================
function prepararModoLivre() {
  partes.forEach((mesh) => {
    const dragBehavior = new PointerDragBehavior({
      dragPlaneNormal: new Vector3(0, 0, 1)
    });
    dragBehavior.useObjectOrientationForDragging = false;
    mesh.addBehavior(dragBehavior);
    dragBehaviors.push({ mesh, behavior: dragBehavior });
  });
  setDragEnabled(true);
}

function setDragEnabled(ativo) {
  dragBehaviors.forEach(({ behavior }) => {
    behavior.enabled = ativo;
  });
}

// =========================================================
// TROCA DE MODO
// =========================================================
function setModo(modo) {
  modoAtual = modo;

  document.querySelectorAll(".mode-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`btn-${modo}`).classList.add("active");

  document.getElementById("explode-panel").style.display = modo === "explodido" ? "block" : "none";

  setDragEnabled(modo === "livre");

  if (modo === "livre") {
    animarExplosaoPara(0);
  } else if (modo === "explodido") {
    const slider = document.getElementById("explode-slider");
    animarExplosaoPara(Number(slider.value) / 100);
  }
}

// =========================================================
// UI — EVENTOS
// =========================================================
document.getElementById("btn-livre").addEventListener("click", () => setModo("livre"));
document.getElementById("btn-explodido").addEventListener("click", () => setModo("explodido"));

document.getElementById("explode-slider").addEventListener("input", (e) => {
  aplicarExplosao(Number(e.target.value) / 100);
});

// =========================================================
// WEBXR — VR e AR com botões dedicados
// =========================================================
const btnVR = document.getElementById("btn-vr");
const btnAR = document.getElementById("btn-ar");
const xrStatus = document.getElementById("xr-status");

async function configurarXR() {
  if (!navigator.xr) {
    console.warn("Este navegador não expõe a API WebXR (navigator.xr ausente).");
    btnVR.disabled = true;
    btnAR.disabled = true;
    xrStatus.textContent = "WebXR indisponível neste navegador";
    return;
  }

  try {
    xrHelper = await scene.createDefaultXRExperienceAsync({
      floorMeshes: chao ? [chao] : [],
      disableDefaultUI: true,
      disableTeleportation: false,
      optionalFeatures: true
    });

    if (!xrHelper || !xrHelper.baseExperience) {
      throw new Error("createDefaultXRExperienceAsync não retornou baseExperience.");
    }

    xrHelper.baseExperience.onStateChangedObservable.add((state) => {
      if (state === 2) {
        xrStatus.textContent = "Sessão XR ativa";
        ativarRenderizacaoRealista(false); // preserva performance no headset

        // painel 3D só aparece em RV — em RA (passthrough) ele
        // ficaria flutuando estranho sobre o ambiente real do usuário
        const modoSessao = xrHelper.baseExperience.sessionManager.sessionMode;
        if (painelControleXR) painelControleXR.setEnabled(modoSessao === "immersive-vr");
      } else if (state === 0) {
        xrStatus.textContent = "";
        ativarRenderizacaoRealista(true); // volta o visual completo no desktop
        if (painelControleXR) painelControleXR.setEnabled(false);
      }
    });

    const vrSuportado = await verificarSuporteXR("immersive-vr");
    const arSuportado = await verificarSuporteXR("immersive-ar");

    btnVR.disabled = !vrSuportado;
    btnAR.disabled = !arSuportado;
    if (!vrSuportado) btnVR.title = "RV não suportada neste dispositivo/navegador";
    if (!arSuportado) btnAR.title = "RA não suportada neste dispositivo/navegador";

    console.log("WebXR configurado. VR:", vrSuportado, "AR:", arSuportado);
  } catch (err) {
    console.warn("WebXR não disponível neste navegador/dispositivo (normal em desktop sem headset).", err.message || err);
    btnVR.disabled = true;
    btnAR.disabled = true;
    xrStatus.textContent = "WebXR indisponível neste navegador";
  }
}

async function verificarSuporteXR(sessionMode) {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
  try {
    return await navigator.xr.isSessionSupported(sessionMode);
  } catch {
    return false;
  }
}

async function entrarXR(sessionMode) {
  if (!xrHelper) return;
  try {
    xrStatus.textContent = "Iniciando sessão...";
    await xrHelper.baseExperience.enterXRAsync(sessionMode, "local-floor", xrHelper.renderTarget);
  } catch (err) {
    console.error(`Erro ao entrar em ${sessionMode}:`, err);
    xrStatus.textContent = `Não foi possível iniciar ${sessionMode === "immersive-ar" ? "RA" : "RV"}`;
  }
}

btnVR.addEventListener("click", () => entrarXR("immersive-vr"));
btnAR.addEventListener("click", () => entrarXR("immersive-ar"));

// =========================================================
// MANUAL DO OPERADOR — PDF sobreposto, sem sair da cena
// =========================================================
const btnManual = document.getElementById("btn-manual");
const btnFecharManual = document.getElementById("btn-fechar-manual");
const manualOverlay = document.getElementById("manual-overlay");
const manualIframe = document.getElementById("manual-iframe");
const manualErro = document.getElementById("manual-erro");

async function abrirManual() {
  manualOverlay.classList.remove("hidden");
  manualErro.classList.add("hidden");
  manualIframe.classList.remove("hidden");

  try {
    const resposta = await fetch(CONFIG.manualPdf, { method: "HEAD" });
    if (!resposta.ok) throw new Error("PDF não encontrado");
    manualIframe.src = CONFIG.manualPdf;
  } catch (err) {
    console.warn("Manual do operador não encontrado:", err.message || err);
    manualIframe.classList.add("hidden");
    manualErro.classList.remove("hidden");
  }
}

function fecharManual() {
  manualOverlay.classList.add("hidden");
  manualIframe.src = ""; // libera memória/para o carregamento do PDF
}

btnManual.addEventListener("click", abrirManual);
btnFecharManual.addEventListener("click", fecharManual);
manualOverlay.addEventListener("click", (e) => {
  if (e.target === manualOverlay) fecharManual(); // clique fora do painel fecha
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !manualOverlay.classList.contains("hidden")) {
    fecharManual();
  }
});

// =========================================================
// LOOP PRINCIPAL
// =========================================================
carregarModelo().then(() => configurarXR());

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
