Pod::Spec.new do |s|
  s.name           = 'GrowbotVoice'
  s.version        = '1.0.0'
  s.summary        = 'GrowBot local system speech adapter'
  s.description    = 'Offline-first AVSpeechSynthesizer integration for GrowBot.'
  s.author         = 'Art of the Problem'
  s.homepage       = 'https://github.com/britcruise9/GrowBot'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: 'https://github.com/britcruise9/GrowBot.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
